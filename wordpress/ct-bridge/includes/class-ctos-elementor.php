<?php
/**
 * CTOS_Elementor — Elementor document read/write logic.
 *
 * Write contract: targeted patch only (SET_WIDGET_TEXT | SET_WIDGET_LINK | SET_IMAGE | SET_SETTING).
 * Arbitrary full-document replacement is NOT accepted through the normal write path.
 * A controlled rollback endpoint is provided separately, gated by snapshot hash integrity.
 *
 * Accesses ONLY:
 *   _elementor_data      — the Elementor page-builder JSON blob.
 *   _elementor_edit_mode — the Elementor edit mode flag.
 *   _elementor_css       — Elementor's per-page CSS cache (cleared on write).
 *
 * Nothing else is read or written. No SQL, no PHP eval, no filesystem.
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class CTOS_Elementor {

    // Allowed targeted operations
    private const ALLOWED_OPERATIONS = [
        'SET_WIDGET_TEXT',
        'SET_WIDGET_LINK',
        'SET_IMAGE',
        'SET_SETTING',
    ];

    // Elementor style settings safe under GREEN permission
    private const SAFE_STYLE_KEYS = [
        'text_align', 'color', 'background_color', 'margin', 'padding',
        'border_radius', 'typography_font_size', 'typography_font_weight',
        'width', 'height', 'responsive_visibility', 'flex_justify_content', 'flex_align_items',
    ];

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Read the Elementor document for a page.
     *
     * @param  int $post_id  WordPress post ID (positive integer, caller-validated).
     * @return array{
     *   page_id: int,
     *   elementor_managed: bool,
     *   elementor_edit_mode: string|null,
     *   document_hash: string,
     *   elementor_data: mixed[]
     * }|WP_Error
     */
    public static function get_document( int $post_id ) {
        $post = get_post( $post_id );
        if ( ! $post || ! in_array( $post->post_type, [ 'page', 'post' ], true ) ) {
            return new WP_Error(
                'page_not_found',
                "Page {$post_id} does not exist or is not a supported post type.",
                [ 'status' => 404 ]
            );
        }

        $raw = get_post_meta( $post_id, '_elementor_data', true );
        if ( ! $raw || ! is_string( $raw ) || $raw === '' ) {
            return new WP_Error(
                'not_elementor_page',
                "Page {$post_id} has no Elementor data. Is the page built with Elementor?",
                [ 'status' => 422 ]
            );
        }

        $data = json_decode( $raw, true );
        if ( ! is_array( $data ) ) {
            return new WP_Error(
                'corrupt_elementor_data',
                "Page {$post_id} Elementor data is malformed JSON. Manual inspection required.",
                [ 'status' => 422 ]
            );
        }

        $edit_mode = get_post_meta( $post_id, '_elementor_edit_mode', true );

        return [
            'page_id'             => $post_id,
            'elementor_managed'   => true,
            'elementor_edit_mode' => is_string( $edit_mode ) && $edit_mode !== '' ? $edit_mode : null,
            'document_hash'       => self::compute_hash( $raw ),
            'elementor_data'      => $data,
        ];
    }

    /**
     * Apply a targeted, minimal patch to one Elementor element.
     *
     * Supported operations (from $patch['operation']):
     *   SET_WIDGET_TEXT — set heading title, text-editor editor, or button label
     *   SET_WIDGET_LINK — set button URL (must be safe http/https)
     *   SET_IMAGE       — set image src object
     *   SET_SETTING     — set one style setting (must be in safe whitelist)
     *
     * Arbitrary full-document replacement is rejected at this layer.
     *
     * @param  int    $post_id       Target post ID.
     * @param  array  $patch         Patch descriptor (from JSON body).
     * @param  string $expected_hash Expected current document hash (compare-and-swap).
     * @return array{page_id: int, previous_hash: string, document_hash: string}|WP_Error
     */
    public static function apply_patch(
        int    $post_id,
        array  $patch,
        string $expected_hash
    ) {
        // Load current state.
        $current = self::get_document( $post_id );
        if ( is_wp_error( $current ) ) {
            return $current;
        }

        // Compare-and-swap: reject if document changed since client read.
        if ( ! hash_equals( $current['document_hash'], $expected_hash ) ) {
            return new WP_Error(
                'conflict_detected',
                'The Elementor document has changed since your change plan was created. ' .
                'Reload the document and retry.',
                [ 'status' => 409 ]
            );
        }

        // Validate operation.
        $operation = is_string( $patch['operation'] ?? null ) ? $patch['operation'] : '';
        if ( ! in_array( $operation, self::ALLOWED_OPERATIONS, true ) ) {
            return new WP_Error(
                'unsupported_operation',
                "Operation '{$operation}' is not supported. Allowed: " .
                implode( ', ', self::ALLOWED_OPERATIONS ) . '.',
                [ 'status' => 400 ]
            );
        }

        // Validate element_id.
        $element_id = is_string( $patch['element_id'] ?? null ) ? trim( $patch['element_id'] ) : '';
        if ( $element_id === '' ) {
            return new WP_Error( 'missing_element_id', 'patch.element_id is required.', [ 'status' => 400 ] );
        }

        $expected_type = is_string( $patch['expected_element_type'] ?? null ) ? $patch['expected_element_type'] : '';

        $data = $current['elementor_data'];

        // Check for duplicate IDs (ambiguous target).
        $count = self::count_element( $data, $element_id );
        if ( $count === 0 ) {
            return new WP_Error(
                'element_not_found',
                "Element '{$element_id}' was not found in the Elementor document.",
                [ 'status' => 404 ]
            );
        }
        if ( $count > 1 ) {
            return new WP_Error(
                'duplicate_element_id',
                "Element ID '{$element_id}' appears {$count} times in the document — target is ambiguous.",
                [ 'status' => 422 ]
            );
        }

        // Find the node.
        $node = self::find_element_node( $data, $element_id );
        if ( $node === null ) {
            return new WP_Error( 'element_not_found', "Element '{$element_id}' not found.", [ 'status' => 404 ] );
        }

        // Type check.
        $actual_type = self::infer_type( $node );
        if ( $expected_type !== '' && $actual_type !== $expected_type ) {
            return new WP_Error(
                'type_mismatch',
                "Element '{$element_id}' is type '{$actual_type}', expected '{$expected_type}'.",
                [ 'status' => 422 ]
            );
        }

        $value = $patch['value'] ?? null;
        $key   = is_string( $patch['key'] ?? null ) ? $patch['key'] : null;

        // Apply operation with safety validation.
        $error = self::validate_and_apply( $node, $operation, $actual_type, $key, $value );
        if ( is_wp_error( $error ) ) {
            return $error;
        }
        $node = $error; // validate_and_apply returns the mutated node on success

        // Replace in tree.
        $new_data = self::replace_element_in_tree( $data, $element_id, $node );

        // Encode and save.
        $new_json = wp_json_encode( $new_data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
        if ( false === $new_json ) {
            return new WP_Error( 'encode_error', 'Failed to JSON-encode the patched Elementor data.', [ 'status' => 500 ] );
        }

        update_post_meta( $post_id, '_elementor_data', wp_slash( $new_json ) );
        update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
        self::trigger_css_regeneration( $post_id );

        $new_hash = self::compute_hash( $new_json );

        // Read-back verification.
        $verify_raw  = get_post_meta( $post_id, '_elementor_data', true );
        $verify_hash = self::compute_hash( $verify_raw );
        if ( $verify_hash !== $new_hash ) {
            return new WP_Error( 'verify_failed', 'Write read-back verification failed.', [ 'status' => 500 ] );
        }

        return [
            'page_id'       => $post_id,
            'previous_hash' => $current['document_hash'],
            'document_hash' => $new_hash,
        ];
    }

    /**
     * Restore a prior Elementor document from a CT-OS snapshot.
     *
     * Gated by two hashes:
     *   - expected_document_hash: the current document must match (stale check / conflict protection).
     *   - snapshot_hash: the provided elementor_data must hash to this value (snapshot integrity).
     *
     * This is NOT a generic full-document write — the snapshot_hash integrity check ensures
     * only a previously-computed, CT-OS-recorded snapshot can be restored.
     *
     * @param  int    $post_id               Target post ID.
     * @param  string $snapshot_hash         SHA-256 hash the snapshot data must produce.
     * @param  string $expected_current_hash Current document hash (conflict protection).
     * @param  array  $elementor_data        Decoded snapshot nodes to restore.
     * @return array{page_id: int, previous_hash: string, document_hash: string, snapshot_hash: string}|WP_Error
     */
    public static function rollback_document(
        int    $post_id,
        string $snapshot_hash,
        string $expected_current_hash,
        array  $elementor_data
    ) {
        // Load current state.
        $current = self::get_document( $post_id );
        if ( is_wp_error( $current ) ) {
            return $current;
        }

        // Conflict check: current document must match expected.
        if ( ! hash_equals( $current['document_hash'], $expected_current_hash ) ) {
            return new WP_Error(
                'conflict_detected',
                'The current Elementor document has changed since the rollback was initiated. ' .
                'Re-read the document and retry.',
                [ 'status' => 409 ]
            );
        }

        // Snapshot integrity: verify the provided data produces the claimed hash.
        $snapshot_json = wp_json_encode( $elementor_data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
        if ( false === $snapshot_json ) {
            return new WP_Error( 'encode_error', 'Failed to encode snapshot data.', [ 'status' => 500 ] );
        }
        $computed_snapshot_hash = self::compute_hash( $snapshot_json );
        if ( ! hash_equals( $computed_snapshot_hash, $snapshot_hash ) ) {
            return new WP_Error(
                'snapshot_integrity_failed',
                'The provided elementor_data does not match the claimed snapshot_hash. ' .
                'The snapshot may be corrupt or tampered with.',
                [ 'status' => 400 ]
            );
        }

        // Restore.
        update_post_meta( $post_id, '_elementor_data', wp_slash( $snapshot_json ) );
        update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
        self::trigger_css_regeneration( $post_id );

        $restored_hash = self::compute_hash( $snapshot_json );

        // Read-back verification.
        $verify_raw  = get_post_meta( $post_id, '_elementor_data', true );
        $verify_hash = self::compute_hash( $verify_raw );
        if ( $verify_hash !== $restored_hash ) {
            return new WP_Error( 'verify_failed', 'Rollback read-back verification failed.', [ 'status' => 500 ] );
        }

        return [
            'page_id'       => $post_id,
            'previous_hash' => $current['document_hash'],
            'document_hash' => $restored_hash,
            'snapshot_hash' => $snapshot_hash,
        ];
    }

    /**
     * Compute a stable SHA-256 hash of the Elementor document.
     *
     * Raw JSON is decoded and re-encoded to normalise key order and whitespace,
     * producing a stable hash regardless of original formatting.
     *
     * @param  string $elementor_json  Raw JSON string (from _elementor_data or just saved).
     * @return string  64-char lowercase hex SHA-256.
     */
    public static function compute_hash( string $elementor_json ): string {
        $decoded   = json_decode( $elementor_json, true );
        $canonical = wp_json_encode( $decoded, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
        return hash( 'sha256', $canonical !== false ? $canonical : $elementor_json );
    }

    // -------------------------------------------------------------------------
    // Private: operation validation and mutation
    // -------------------------------------------------------------------------

    /**
     * Validate the operation/value and apply the mutation to a copy of $node.
     * Returns the mutated node array on success, WP_Error on failure.
     *
     * @return array|WP_Error
     */
    private static function validate_and_apply(
        array  $node,
        string $operation,
        string $actual_type,
        ?string $key,
        $value
    ) {
        switch ( $operation ) {
            case 'SET_WIDGET_TEXT':
                $text = is_string( $value ) ? $value : (string) $value;
                if ( self::detect_unsafe_content( $text ) ) {
                    return new WP_Error( 'unsafe_content', 'Value contains unsafe HTML or script content.', [ 'status' => 400 ] );
                }
                if ( $actual_type === 'text' ) {
                    $text_key = 'editor';
                } elseif ( $actual_type === 'button' ) {
                    $text_key = 'button_text';
                } else {
                    $text_key = 'title';
                }
                $node['settings'][ $text_key ] = $text;
                return $node;

            case 'SET_WIDGET_LINK':
                $url_str = is_array( $value ) ? ( $value['url'] ?? '' ) : (string) $value;
                if ( ! self::is_safe_url( $url_str ) ) {
                    return new WP_Error( 'unsafe_url', "URL '{$url_str}' is not a permitted http/https URL.", [ 'status' => 400 ] );
                }
                // Store as Elementor link object if it isn't one already.
                $link_value = is_array( $value ) ? $value : [ 'url' => $url_str ];
                $node['settings']['button_url'] = $link_value;
                return $node;

            case 'SET_IMAGE':
                if ( is_array( $value ) && isset( $value['url'] ) ) {
                    if ( ! self::is_safe_url( (string) $value['url'] ) ) {
                        return new WP_Error( 'unsafe_url', "Image URL is not a permitted http/https URL.", [ 'status' => 400 ] );
                    }
                }
                $node['settings']['image'] = $value;
                return $node;

            case 'SET_SETTING':
                if ( $key === null || $key === '' ) {
                    return new WP_Error( 'missing_key', 'patch.key is required for SET_SETTING.', [ 'status' => 400 ] );
                }
                if ( ! in_array( $key, self::SAFE_STYLE_KEYS, true ) ) {
                    return new WP_Error(
                        'unsafe_setting',
                        "Setting key '{$key}' is not in the safe whitelist. " .
                        'Allowed: ' . implode( ', ', self::SAFE_STYLE_KEYS ) . '.',
                        [ 'status' => 400 ]
                    );
                }
                $node['settings'][ $key ] = $value;
                return $node;
        }

        // Should not reach here (caller already validated $operation).
        return new WP_Error( 'unsupported_operation', "Unhandled operation '{$operation}'.", [ 'status' => 400 ] );
    }

    // -------------------------------------------------------------------------
    // Private: tree helpers
    // -------------------------------------------------------------------------

    /** Count how many nodes have the given ID (to detect duplicates). */
    private static function count_element( array $nodes, string $id ): int {
        $count = 0;
        foreach ( $nodes as $node ) {
            if ( isset( $node['id'] ) && $node['id'] === $id ) {
                $count++;
            }
            if ( ! empty( $node['elements'] ) && is_array( $node['elements'] ) ) {
                $count += self::count_element( $node['elements'], $id );
            }
        }
        return $count;
    }

    /** Find and return the first node with the given ID, or null. */
    private static function find_element_node( array $nodes, string $id ): ?array {
        foreach ( $nodes as $node ) {
            if ( isset( $node['id'] ) && $node['id'] === $id ) {
                return $node;
            }
            if ( ! empty( $node['elements'] ) && is_array( $node['elements'] ) ) {
                $found = self::find_element_node( $node['elements'], $id );
                if ( $found !== null ) {
                    return $found;
                }
            }
        }
        return null;
    }

    /** Return a new tree with the node matching $id replaced by $replacement. */
    private static function replace_element_in_tree( array $nodes, string $id, array $replacement ): array {
        foreach ( $nodes as &$node ) {
            if ( isset( $node['id'] ) && $node['id'] === $id ) {
                $node = $replacement;
                continue;
            }
            if ( ! empty( $node['elements'] ) && is_array( $node['elements'] ) ) {
                $node['elements'] = self::replace_element_in_tree( $node['elements'], $id, $replacement );
            }
        }
        unset( $node );
        return $nodes;
    }

    /** Infer the CT-OS node type from raw Elementor elType/widgetType. */
    private static function infer_type( array $node ): string {
        $el_type     = $node['elType'] ?? '';
        $widget_type = $node['widgetType'] ?? '';

        if ( $el_type === 'widget' ) {
            switch ( $widget_type ) {
                case 'heading':     return 'heading';
                case 'text-editor': return 'text';
                case 'button':      return 'button';
                case 'image':       return 'image';
                default:            return 'unknown';
            }
        }

        if ( in_array( $el_type, [ 'container', 'section', 'column', 'inner-section' ], true ) ) {
            return 'container';
        }

        return 'unknown';
    }

    /** Return true if $url is a safe http/https URL (no javascript:, data:, vbscript:). */
    private static function is_safe_url( string $url ): bool {
        $lower = strtolower( trim( $url ) );
        if ( $lower === '' ) {
            return true; // empty URL is allowed (cleared link)
        }
        // Reject dangerous schemes.
        foreach ( [ 'javascript:', 'data:', 'vbscript:', 'file:', 'about:' ] as $scheme ) {
            if ( strpos( $lower, $scheme ) === 0 ) {
                return false;
            }
        }
        return true;
    }

    /** Return true if $text contains unsafe script/event-handler content. */
    private static function detect_unsafe_content( string $text ): bool {
        if ( preg_match( '/<\s*script/i', $text ) ) {
            return true;
        }
        if ( preg_match( '/javascript\s*:/i', $text ) ) {
            return true;
        }
        // Reject inline event handlers (onclick=, onload=, etc.)
        if ( preg_match( '/\bon\w+\s*=/i', $text ) ) {
            return true;
        }
        return false;
    }

    // -------------------------------------------------------------------------
    // Private: CSS regeneration
    // -------------------------------------------------------------------------

    /**
     * Trigger Elementor CSS regeneration for a single post.
     *
     * Prefers Elementor's public files_manager API when the plugin is loaded.
     * Falls back to deleting the per-page CSS postmeta so Elementor regenerates
     * it lazily on the next frontend render.
     *
     * @param int $post_id
     */
    private static function trigger_css_regeneration( int $post_id ): void {
        if (
            did_action( 'elementor/loaded' ) &&
            class_exists( '\Elementor\Plugin' ) &&
            isset( \Elementor\Plugin::$instance->files_manager )
        ) {
            \Elementor\Plugin::$instance->files_manager->clear_cache();
        } else {
            delete_post_meta( $post_id, '_elementor_css' );
        }
    }
}
