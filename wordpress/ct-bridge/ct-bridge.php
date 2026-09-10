<?php
/**
 * Plugin Name: CT Bridge
 * Plugin URI:  https://creativetouch.agency
 * Description: Creative Touch CT-OS Elementor bridge. Exposes narrow, capability-gated REST
 *              endpoints for controlled Elementor document reads and targeted writes. No
 *              arbitrary meta, PHP, SQL, or filesystem access.
 * Version:     1.0.0
 * Author:      Creative Touch
 * Requires at least: 6.4
 * Requires PHP: 8.0
 * License:     Proprietary
 *
 * Security model:
 *   - Every route requires an authenticated WordPress user (Application Password or session).
 *   - Read requires edit_pages capability.
 *   - Write requires current_user_can('edit_post', $page_id) on the specific target page.
 *   - No generic postmeta access; only _elementor_data and _elementor_edit_mode are touched.
 *   - No PHP eval, no SQL, no filesystem, no plugin/theme/user/option mutation.
 *   - Credentials are never included in responses or error messages.
 */

// Prevent direct file access.
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

define( 'CTOS_BRIDGE_VERSION', '1.0.0' );
define( 'CTOS_BRIDGE_DIR', plugin_dir_path( __FILE__ ) );

require_once CTOS_BRIDGE_DIR . 'includes/class-ctos-elementor.php';
require_once CTOS_BRIDGE_DIR . 'includes/class-ctos-rest.php';

/**
 * Register CT Bridge REST routes once the WP REST infrastructure is ready.
 */
add_action( 'rest_api_init', static function (): void {
    ( new CTOS_REST() )->register_routes();
} );
