<?php
/**
 * Import a WXR file while short-circuiting attachment HTTP fetches against a
 * local source directory. Mirrors `wp-cli/import-command`'s `--source-dir`
 * behavior for environments (like Studio) whose bundled wp-cli predates that
 * flag.
 *
 * The filter matches `basename( parse_url( $url )['path'] )` against files
 * directly under `$source_dir`. A match returns a synthetic 200 response with
 * the local file's bytes; WP_Import hands that to its normal save path, so
 * attachment posts end up with correct `_wp_attached_file` / GUID, thumbnail
 * generation runs, etc.
 *
 * Usage:
 *   wp eval-file import-wxr.php <wxr-path> <source-dir>
 *
 * Must be run via WP-CLI. Will not execute in a web context.
 *
 * @package Studio
 */

if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) {
	return;
}

$wxr_path   = isset( $args[0] ) ? $args[0] : '';
$source_dir = isset( $args[1] ) ? rtrim( $args[1], '/\\' ) : '';

if ( empty( $wxr_path ) || ! file_exists( $wxr_path ) ) {
	WP_CLI::error( "WXR not found: $wxr_path" );
}
if ( empty( $source_dir ) || ! is_dir( $source_dir ) ) {
	WP_CLI::error( "Source dir not found: $source_dir" );
}
if ( ! is_readable( $source_dir ) ) {
	WP_CLI::error( "Source dir not readable: $source_dir" );
}

define( 'WP_LOAD_IMPORTERS', true );
require_once ABSPATH . 'wp-admin/includes/admin.php';

// This script is expected to be invoked with `--skip-plugins=wordpress-importer`
// (see studio.ts). That prevents WP-CLI's bootstrap from loading the plugin
// before we've defined WP_LOAD_IMPORTERS — which would leave the class
// undefined AND cache the file in require_once, OR (in single-file layouts)
// declare functions that then conflict when we try to re-include. With the
// plugin skipped, this require_once is the first load and everything wires up.
if ( ! class_exists( 'WP_Import' ) ) {
	$candidates = array(
		WP_PLUGIN_DIR . '/wordpress-importer/src/wordpress-importer.php',
		WP_PLUGIN_DIR . '/wordpress-importer/wordpress-importer.php',
	);
	$loaded = false;
	foreach ( $candidates as $candidate ) {
		if ( file_exists( $candidate ) ) {
			require_once $candidate;
			$loaded = true;
			break;
		}
	}
	if ( ! $loaded ) {
		WP_CLI::error( 'wordpress-importer plugin files not found under ' . WP_PLUGIN_DIR );
	}
}
if ( ! class_exists( 'WP_Import' ) ) {
	WP_CLI::error( 'WP_Import class still not defined after loading the plugin. Did you remember to pass --skip-plugins=wordpress-importer on the wp-cli invocation?' );
}

$hits   = 0;
$misses = array();

add_filter(
	'pre_http_request',
	function ( $pre, $args, $url ) use ( $source_dir, &$hits, &$misses ) {
		if ( false !== $pre ) {
			return $pre;
		}
		$url_path = parse_url( $url, PHP_URL_PATH );
		if ( ! $url_path ) {
			return $pre;
		}
		$file_name = basename( $url_path );
		if ( ! $file_name || '.' === $file_name || '..' === $file_name ) {
			return $pre;
		}
		$local_file = $source_dir . DIRECTORY_SEPARATOR . $file_name;
		if ( ! file_exists( $local_file ) || ! is_file( $local_file ) ) {
			$misses[] = $url;
			return $pre;
		}
		$hits++;
		$mime_info = wp_check_filetype( $file_name );
		$mime      = ( isset( $mime_info['type'] ) && $mime_info['type'] ) ? $mime_info['type'] : 'application/octet-stream';
		$size      = filesize( $local_file );
		$method    = isset( $args['method'] ) ? strtoupper( $args['method'] ) : 'GET';
		$headers   = array(
			'content-type'   => $mime,
			'content-length' => $size,
		);
		// HEAD: headers only.
		if ( 'HEAD' === $method ) {
			return array(
				'headers'  => $headers,
				'body'     => '',
				'response' => array( 'code' => 200, 'message' => 'OK' ),
				'cookies'  => array(),
				'filename' => null,
			);
		}
		// Stream mode (WP_Import passes stream=true + filename=<temp>): copy
		// the local file to the requested path and return an empty-body
		// response. Callers read from $args['filename'] in stream mode.
		if ( ! empty( $args['stream'] ) && ! empty( $args['filename'] ) ) {
			if ( ! @copy( $local_file, $args['filename'] ) ) {
				return new WP_Error( 'dla_source_copy_failed', "Could not copy $local_file to {$args['filename']}" );
			}
			return array(
				'headers'  => $headers,
				'body'     => '',
				'response' => array( 'code' => 200, 'message' => 'OK' ),
				'cookies'  => array(),
				'filename' => $args['filename'],
			);
		}
		// Non-stream GET: return the body inline.
		return array(
			'headers'  => $headers,
			'body'     => file_get_contents( $local_file ),
			'response' => array( 'code' => 200, 'message' => 'OK' ),
			'cookies'  => array(),
			'filename' => null,
		);
	},
	10,
	3
);

// Rewrite target in studio.ts uses `http://127.0.0.1/<filename>` as a sentinel.
// wp_http_validate_url blocks 127.0.0.1 by default (private IP) when
// reject_unsafe_urls is set (wp_safe_remote_get sets it true); whitelist it
// so validation passes. The pre_http_request filter above short-circuits
// before any real network call anyway.
add_filter(
	'http_request_host_is_external',
	function ( $external, $host ) {
		return ( '127.0.0.1' === $host ) ? true : $external;
	},
	10,
	2
);

// Minimum boilerplate to drive wordpress-importer headlessly — mirrors what
// the plugin's own CLI path does.
kses_remove_filters();
$admins = get_users( array( 'role' => 'Administrator' ) );
if ( ! empty( $admins ) ) {
	wp_set_current_user( $admins[0]->ID );
}

$wp_import                    = new WP_Import();
$wp_import->fetch_attachments = true;

$_GET  = array(
	'import' => 'wordpress',
	'step'   => 2,
);
$_POST = array(
	'imported_authors'  => array(),
	'user_map'          => array(),
	'fetch_attachments' => true,
);

WP_CLI::log( "Importing $wxr_path with source-dir $source_dir" );

ob_start();
$wp_import->import( $wxr_path );
$import_output = ob_get_clean();
WP_CLI::log( $import_output );

WP_CLI::log( sprintf( 'Attachment short-circuit: %d hits, %d misses.', $hits, count( $misses ) ) );
if ( ! empty( $misses ) ) {
	$sample = array_slice( $misses, 0, 5 );
	WP_CLI::log( 'Sample misses: ' . implode( ', ', $sample ) );
}

WP_CLI::success( 'WXR import complete.' );
