<?php
/**
 * CTOS_REST — REST route registration and request handlers.
 *
 * Namespace:  ctos/v1
 *
 * Routes:
 *   GET   /wp-json/ctos/v1/elementor/{page_id}
 *         Read the Elementor document for a page.
 *         Permission: is_user_logged_in() && current_user_can('edit_pages')
 *
 *   PATCH /wp-json/ctos/v1/elementor/{page_id}
 *         Apply a TARGETED patch to one Elementor element.
 *         Body: { expected_document_hash, patch: { operation, element_id, expected_element_type, key?, value } }
 *         Supported operations: SET_WIDGET_TEXT | SET_WIDGET_LINK | SET_IMAGE | SET_SETTING
 *         Arbitrary full-document replacement is NOT accepted.
 *         Permission: is_user_logged_in() && current_user_can('edit_post', $page_id)
 *
 *   POST  /wp-json/ctos/v1/elementor/{page_id}/rollback
 *         Restore a prior Elementor document from a CT-OS snapshot.
 *         Body: { snapshot_hash, expected_document_hash, elementor_data: [...] }
 *         Snapshot integrity is verified (elementor_data must hash to snapshot_hash).
 *         Permission: is_user_logged_in() && current_user_can('edit_post', $page_id)
 *
 * Explicitly NOT exposed:
 *   - Arbitrary postmeta (GET, SET, DELETE)
 *   - PHP execution
 *   - SQL queries
 *   - Filesystem operations
 *   - Plugin, theme, user, or options mutation
 *   - Any route not defined here
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class CTOS_REST {

    public const NAMESPACE            = 'ctos/v1';
    public const ROUTE_ELEMENTOR      = '/elementor/(?P<page_id>[1-9][0-9]*)';
    public const ROUTE_ELEMENTOR_ROLLBACK = '/elementor/(?P<page_id>[1-9][0-9]*)/rollback';
    private const HASH_PATTERN        = '/^[a-f0-9]{64}$/';

    // -------------------------------------------------------------------------
    // Route registration
    // -------------------------------------------------------------------------

    public function register_routes(): void {
        // GET + PATCH /elementor/{page_id}
        register_rest_route(
            self::NAMESPACE,
            self::ROUTE_ELEMENTOR,
            [
                // --- GET ---
                [
                    'methods'             => WP_REST_Server::READABLE,
                    'callback'            => [ $this, 'handle_get' ],
                    'permission_callback' => [ $this, 'permission_read' ],
                    'args'                => self::page_id_arg(),
                ],
                // --- PATCH (targeted patch only) ---
                [
                    'methods'             => 'PATCH',
                    'callback'            => [ $this, 'handle_patch' ],
                    'permission_callback' => [ $this, 'permission_write' ],
                    'args'                => array_merge(
                        self::page_id_arg(),
                        [
                            'expected_document_hash' => [
                                'required'          => true,
                                'type'              => 'string',
                                'description'       => '64-char hex SHA-256 of the document as read by the client.',
                                'sanitize_callback' => 'sanitize_text_field',
                                'validate_callback' => fn ( $v ) => is_string( $v ) &&
                                    preg_match( self::HASH_PATTERN, $v ) === 1,
                            ],
                            'patch' => [
                                'required'    => true,
                                'type'        => 'object',
                                'description' => 'Targeted patch descriptor: { operation, element_id, expected_element_type, key?, value }.',
                            ],
                        ]
                    ),
                ],
            ]
        );

        // POST /elementor/{page_id}/rollback
        register_rest_route(
            self::NAMESPACE,
            self::ROUTE_ELEMENTOR_ROLLBACK,
            [
                [
                    'methods'             => WP_REST_Server::CREATABLE,
                    'callback'            => [ $this, 'handle_rollback' ],
                    'permission_callback' => [ $this, 'permission_write' ],
                    'args'                => array_merge(
                        self::page_id_arg(),
                        [
                            'snapshot_hash' => [
                                'required'          => true,
                                'type'              => 'string',
                                'description'       => '64-char hex SHA-256 the snapshot data must produce.',
                                'sanitize_callback' => 'sanitize_text_field',
                                'validate_callback' => fn ( $v ) => is_string( $v ) &&
                                    preg_match( self::HASH_PATTERN, $v ) === 1,
                            ],
                            'expected_document_hash' => [
                                'required'          => true,
                                'type'              => 'string',
                                'description'       => '64-char hex SHA-256 of the CURRENT document (conflict protection).',
                                'sanitize_callback' => 'sanitize_text_field',
                                'validate_callback' => fn ( $v ) => is_string( $v ) &&
                                    preg_match( self::HASH_PATTERN, $v ) === 1,
                            ],
                            'elementor_data' => [
                                'required'    => true,
                                'type'        => 'array',
                                'description' => 'Snapshot Elementor nodes array to restore.',
                            ],
                        ]
                    ),
                ],
            ]
        );
    }

    // -------------------------------------------------------------------------
    // Permission callbacks
    // -------------------------------------------------------------------------

    /**
     * GET permission: authenticated user with edit_pages capability.
     */
    public function permission_read( WP_REST_Request $request ) {
        if ( ! is_user_logged_in() ) {
            return new WP_Error(
                'rest_not_logged_in',
                'Authentication required. Use a WordPress Application Password.',
                [ 'status' => 401 ]
            );
        }
        if ( ! current_user_can( 'edit_pages' ) ) {
            return new WP_Error(
                'rest_forbidden',
                'The edit_pages capability is required to read Elementor documents.',
                [ 'status' => 403 ]
            );
        }
        return true;
    }

    /**
     * PATCH + POST rollback permission: authenticated user who can edit the target page.
     */
    public function permission_write( WP_REST_Request $request ) {
        if ( ! is_user_logged_in() ) {
            return new WP_Error(
                'rest_not_logged_in',
                'Authentication required. Use a WordPress Application Password.',
                [ 'status' => 401 ]
            );
        }

        $page_id = absint( $request->get_param( 'page_id' ) );
        if ( $page_id < 1 ) {
            return new WP_Error( 'rest_bad_request', 'Invalid page_id.', [ 'status' => 400 ] );
        }

        if ( ! current_user_can( 'edit_post', $page_id ) ) {
            return new WP_Error(
                'rest_forbidden',
                "You do not have permission to edit page {$page_id}.",
                [ 'status' => 403 ]
            );
        }

        return true;
    }

    // -------------------------------------------------------------------------
    // Request handlers
    // -------------------------------------------------------------------------

    /**
     * GET /ctos/v1/elementor/{page_id}
     *
     * Returns:
     * {
     *   "page_id": 316,
     *   "elementor_managed": true,
     *   "elementor_edit_mode": "builder"|null,
     *   "document_hash": "<64-char hex SHA-256>",
     *   "elementor_data": [...]
     * }
     */
    public function handle_get( WP_REST_Request $request ) {
        $page_id = absint( $request->get_param( 'page_id' ) );
        $result  = CTOS_Elementor::get_document( $page_id );

        if ( is_wp_error( $result ) ) {
            return $result;
        }

        return new WP_REST_Response( $result, 200 );
    }

    /**
     * PATCH /ctos/v1/elementor/{page_id}
     *
     * Applies a single targeted operation to one Elementor element.
     *
     * Body (JSON):
     * {
     *   "expected_document_hash": "<64-char hex>",
     *   "patch": {
     *     "operation": "SET_WIDGET_TEXT",
     *     "element_id": "abc123",
     *     "expected_element_type": "heading",
     *     "expected_current_value": "Old Title",
     *     "key": null,
     *     "value": "New Title"
     *   }
     * }
     *
     * Returns on success:
     * { "page_id": 316, "previous_hash": "...", "document_hash": "..." }
     *
     * Returns on conflict (HTTP 409):
     * { "code": "conflict_detected", "message": "..." }
     *
     * Returns on type mismatch (HTTP 422):
     * { "code": "type_mismatch", "message": "..." }
     *
     * Returns on not found (HTTP 404):
     * { "code": "element_not_found", "message": "..." }
     */
    public function handle_patch( WP_REST_Request $request ) {
        $page_id       = absint( $request->get_param( 'page_id' ) );
        $expected_hash = sanitize_text_field( (string) $request->get_param( 'expected_document_hash' ) );
        $patch         = $request->get_param( 'patch' );

        // Redundant validation (args already validated by WP REST, but defence-in-depth).
        if ( ! preg_match( self::HASH_PATTERN, $expected_hash ) ) {
            return new WP_Error(
                'invalid_hash',
                'expected_document_hash must be a 64-character lowercase hex SHA-256.',
                [ 'status' => 400 ]
            );
        }

        if ( ! is_array( $patch ) ) {
            return new WP_Error(
                'invalid_patch',
                'patch must be a JSON object.',
                [ 'status' => 400 ]
            );
        }

        $result = CTOS_Elementor::apply_patch( $page_id, $patch, $expected_hash );

        if ( is_wp_error( $result ) ) {
            return $result;
        }

        return new WP_REST_Response( $result, 200 );
    }

    /**
     * POST /ctos/v1/elementor/{page_id}/rollback
     *
     * Restores a prior Elementor document from a CT-OS snapshot.
     * The snapshot_hash integrity check prevents arbitrary document injection.
     *
     * Body (JSON):
     * {
     *   "snapshot_hash": "<64-char hex SHA-256 of the snapshot>",
     *   "expected_document_hash": "<64-char hex SHA-256 of the CURRENT document>",
     *   "elementor_data": [...]
     * }
     *
     * Returns on success:
     * { "page_id": 316, "previous_hash": "...", "document_hash": "...", "snapshot_hash": "..." }
     */
    public function handle_rollback( WP_REST_Request $request ) {
        $page_id              = absint( $request->get_param( 'page_id' ) );
        $snapshot_hash        = sanitize_text_field( (string) $request->get_param( 'snapshot_hash' ) );
        $expected_current     = sanitize_text_field( (string) $request->get_param( 'expected_document_hash' ) );
        $elementor_data       = $request->get_param( 'elementor_data' );

        // Redundant validation (defence-in-depth).
        if ( ! preg_match( self::HASH_PATTERN, $snapshot_hash ) || ! preg_match( self::HASH_PATTERN, $expected_current ) ) {
            return new WP_Error(
                'invalid_hash',
                'snapshot_hash and expected_document_hash must both be 64-character lowercase hex SHA-256.',
                [ 'status' => 400 ]
            );
        }

        if ( ! is_array( $elementor_data ) ) {
            return new WP_Error(
                'invalid_data',
                'elementor_data must be a JSON array.',
                [ 'status' => 400 ]
            );
        }

        $result = CTOS_Elementor::rollback_document(
            $page_id,
            $snapshot_hash,
            $expected_current,
            $elementor_data
        );

        if ( is_wp_error( $result ) ) {
            return $result;
        }

        return new WP_REST_Response( $result, 200 );
    }

    // -------------------------------------------------------------------------
    // Shared arg definitions
    // -------------------------------------------------------------------------

    /** @return array<string, array<string, mixed>> */
    private static function page_id_arg(): array {
        return [
            'page_id' => [
                'required'          => true,
                'type'              => 'integer',
                'minimum'           => 1,
                'description'       => 'WordPress post ID of the target page.',
                'sanitize_callback' => 'absint',
                'validate_callback' => fn ( $v ) => is_numeric( $v ) && (int) $v > 0,
            ],
        ];
    }
}
