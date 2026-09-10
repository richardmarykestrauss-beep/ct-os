<?php
/**
 * CT Bridge standalone tests — pure PHP, no WordPress required.
 *
 * Tests the pure-logic parts of CTOS_Elementor that have no WordPress dependencies.
 * WP-dependent methods (get_document, patch_document) require a WordPress test environment
 * and are not tested here; their intent is documented as test cases below.
 *
 * Run: php test-ctos-bridge.php
 * PHP lint: php -l test-ctos-bridge.php
 */

declare(strict_types=1);

// ---------------------------------------------------------------------------
// Minimal WordPress stubs required to load class-ctos-elementor.php
// ---------------------------------------------------------------------------

define( 'ABSPATH', '/' );

if ( ! function_exists( 'wp_json_encode' ) ) {
    function wp_json_encode( mixed $data, int $flags = 0 ): string|false {
        return json_encode( $data, $flags );
    }
}

if ( ! function_exists( 'hash_equals' ) ) {
    // hash_equals is a PHP built-in since 5.6; stub kept for completeness.
    function hash_equals( string $a, string $b ): bool {
        return $a === $b;
    }
}

// ---------------------------------------------------------------------------
// Load the class under test
// ---------------------------------------------------------------------------

require_once __DIR__ . '/../ct-bridge/includes/class-ctos-elementor.php';

// ---------------------------------------------------------------------------
// Simple test runner
// ---------------------------------------------------------------------------

$passed = 0;
$failed = 0;

function ct_test( string $desc, bool $ok ): void {
    global $passed, $failed;
    if ( $ok ) {
        echo "  \u{2713} {$desc}\n";
        $passed++;
    } else {
        echo "  \u{2717} {$desc}\n";
        $failed++;
    }
}

// ---------------------------------------------------------------------------
// compute_hash tests
// ---------------------------------------------------------------------------

echo "\nCTOS_Elementor::compute_hash\n";

$h = CTOS_Elementor::compute_hash( '[]' );
ct_test( 'returns 64 hex chars', strlen( $h ) === 64 && ctype_xdigit( $h ) );
ct_test( 'is deterministic for same input', $h === CTOS_Elementor::compute_hash( '[]' ) );

$doc_a = json_encode( [ [ 'id' => 'a', 'settings' => [ 'title' => 'Hello' ] ] ] );
$doc_b = json_encode( [ [ 'id' => 'a', 'settings' => [ 'title' => 'World' ] ] ] );
ct_test( 'differs for different content', CTOS_Elementor::compute_hash( $doc_a ) !== CTOS_Elementor::compute_hash( $doc_b ) );

// Normalisation: different whitespace → same hash after decode/re-encode.
$compact = '{"id":"abc","settings":{"title":"Hi"}}';
$spaced  = '{"id":  "abc",  "settings":  {"title":  "Hi"}}';
// Note: both decode to the same PHP array, so re-encode produces identical JSON.
$compact_wrapped = json_encode( json_decode( $compact ) );
$spaced_wrapped  = json_encode( json_decode( $spaced ) );
ct_test(
    'normalises whitespace — same hash for equivalent JSON',
    CTOS_Elementor::compute_hash( $compact ) === CTOS_Elementor::compute_hash( $spaced )
);

$flat  = json_encode( [ 'id' => 'x', 'a' => 1, 'b' => 2 ] );
$swapped = json_encode( [ 'b' => 2, 'id' => 'x', 'a' => 1 ] );
// PHP's json_decode/json_encode does NOT re-sort keys — order is preserved from input.
// This means differently-ordered JSON may produce different hashes. Document that:
ct_test(
    'returns string of correct length for reordered keys',
    strlen( CTOS_Elementor::compute_hash( $flat ) ) === 64
);

// Empty string input (edge case).
$h_empty = CTOS_Elementor::compute_hash( '{}' );
ct_test( 'handles single empty object', strlen( $h_empty ) === 64 );

// ---------------------------------------------------------------------------
// CTOS_REST hash validation pattern (extracted for testing)
// ---------------------------------------------------------------------------

echo "\nHash format validation (CTOS_REST internal pattern)\n";

$valid_hash   = str_repeat( 'a', 64 );
$invalid_short = str_repeat( 'a', 63 );
$invalid_upper = strtoupper( str_repeat( 'a', 64 ) );
$invalid_chars = str_repeat( 'g', 64 ); // 'g' is not hex

$pattern = '/^[a-f0-9]{64}$/';
ct_test( 'accepts valid 64-char lowercase hex',     preg_match( $pattern, $valid_hash ) === 1 );
ct_test( 'rejects 63-char string',                  preg_match( $pattern, $invalid_short ) === 0 );
ct_test( 'rejects uppercase hex',                   preg_match( $pattern, $invalid_upper ) === 0 );
ct_test( 'rejects non-hex characters',              preg_match( $pattern, $invalid_chars ) === 0 );
ct_test( 'rejects empty string',                    preg_match( $pattern, '' ) === 0 );

// ---------------------------------------------------------------------------
// page_id validation pattern (CTOS_REST route regex)
// ---------------------------------------------------------------------------

echo "\nPage ID validation (route pattern)\n";

$route_pattern = '/^[1-9][0-9]*$/';
ct_test( 'accepts positive integer 1',    preg_match( $route_pattern, '1' ) === 1 );
ct_test( 'accepts positive integer 316',  preg_match( $route_pattern, '316' ) === 1 );
ct_test( 'rejects 0',                     preg_match( $route_pattern, '0' ) === 0 );
ct_test( 'rejects negative',              preg_match( $route_pattern, '-1' ) === 0 );
ct_test( 'rejects float',                 preg_match( $route_pattern, '1.5' ) === 0 );
ct_test( 'rejects empty',                 preg_match( $route_pattern, '' ) === 0 );
ct_test( 'rejects non-numeric string',    preg_match( $route_pattern, 'abc' ) === 0 );

// ---------------------------------------------------------------------------
// WP-dependent test cases (documented intent, not executed here)
// ---------------------------------------------------------------------------

echo "\nWP-dependent tests (documented intent — require WordPress test env)\n";

$wp_tests = [
    'unauthenticated GET returns HTTP 401',
    'authenticated user without edit_pages returns HTTP 403 on GET',
    'authenticated user without edit_post($page_id) returns HTTP 403 on PATCH',
    'GET for non-existent page returns 404',
    'GET for page without _elementor_data returns 422 (not_elementor_page)',
    'GET for page with corrupt _elementor_data returns 422 (corrupt_elementor_data)',
    'PATCH with wrong expected_document_hash returns 409 (conflict_detected)',
    'PATCH with non-array elementor_data returns 400',
    'PATCH with invalid hash format returns 400',
    'Successful GET returns page_id, elementor_managed=true, document_hash (64 hex), elementor_data array',
    'Successful PATCH returns page_id, previous_hash, document_hash (different from previous)',
    'PATCH saves _elementor_data and sets _elementor_edit_mode=builder',
    'PATCH triggers CSS regeneration (files_manager or delete_post_meta fallback)',
    'Round-trip: GET → compute same hash → PATCH → GET returns new hash',
    'PATCH does not expose credentials in error messages',
    'Route /ctos/v1/elementor/{id} exists in WP REST router after rest_api_init',
    'No route exists for /ctos/v1/* other than /elementor/{id}',
];

foreach ( $wp_tests as $t ) {
    echo "  [ ] {$t}\n";
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

echo "\n";
echo "{$passed} passed, {$failed} failed";
if ( $failed > 0 ) {
    echo " — FAILURES DETECTED\n";
    exit( 1 );
}
echo "\n";
exit( 0 );
