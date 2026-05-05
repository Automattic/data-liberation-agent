<?php
/**
 * Register pre-staged media files as WordPress attachments.
 *
 * Reads a JSON payload describing one or more media files that have already
 * been copied into the running site's wp-content/uploads/<year>/<month>/
 * directory, then calls wp_insert_attachment for each one. Idempotent:
 * before inserting it queries `_wp_attached_file` for an existing post; if
 * found, the existing post ID is reused instead.
 *
 * Used by `installMediaForUrl` in the streaming pipeline (Phase 1.5) to
 * synchronously import per-URL media into the live replica WP site so pages
 * render with real images during streaming rather than broken thumbnails.
 *
 * Input JSON shape:
 *   [
 *     {
 *       "filename": "hero.jpg",
 *       "year": "2024",
 *       "month": "11",
 *       "sourceUrl": "https://cdn.example.com/hero.jpg",
 *       "title":     "hero",            // optional; falls back to filename
 *       "mimeType":  "image/jpeg"        // optional; auto-detected via WP if omitted
 *     },
 *     ...
 *   ]
 *
 * Output (single line of JSON to stdout):
 *   {
 *     "results": [
 *       { "sourceUrl": "...", "filename": "hero.jpg", "postId": 42, "reused": false, "localUrl": "https://.../uploads/2024/11/hero.jpg" },
 *       ...
 *     ],
 *     "errors": [
 *       { "sourceUrl": "...", "filename": "...", "error": "..." }
 *     ]
 *   }
 *
 * Usage:
 *   wp eval-file install-media.php <payload.json>
 *
 * Must run via WP-CLI. Will not execute in a web context.
 *
 * @package Studio
 */

if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) {
	return;
}

$payload_path = isset( $args[0] ) ? $args[0] : '';
if ( empty( $payload_path ) || ! file_exists( $payload_path ) ) {
	WP_CLI::error( "Payload not found: $payload_path" );
}

$raw = file_get_contents( $payload_path );
if ( false === $raw ) {
	WP_CLI::error( "Could not read payload: $payload_path" );
}

$entries = json_decode( $raw, true );
if ( ! is_array( $entries ) ) {
	WP_CLI::error( 'Payload JSON must be an array of entries.' );
}

require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

$uploads = wp_upload_dir();
$results = array();
$errors  = array();

foreach ( $entries as $entry ) {
	$filename   = isset( $entry['filename'] ) ? (string) $entry['filename'] : '';
	$year       = isset( $entry['year'] ) ? (string) $entry['year'] : '';
	$month      = isset( $entry['month'] ) ? (string) $entry['month'] : '';
	$source_url = isset( $entry['sourceUrl'] ) ? (string) $entry['sourceUrl'] : '';

	if ( '' === $filename || '' === $year || '' === $month ) {
		$errors[] = array(
			'sourceUrl' => $source_url,
			'filename'  => $filename,
			'error'     => 'Missing filename/year/month in entry',
		);
		continue;
	}

	$rel_path = $year . '/' . $month . '/' . $filename;
	$abs_path = trailingslashit( $uploads['basedir'] ) . $rel_path;

	if ( ! file_exists( $abs_path ) ) {
		$errors[] = array(
			'sourceUrl' => $source_url,
			'filename'  => $filename,
			'error'     => 'File not found at expected uploads path: ' . $abs_path,
		);
		continue;
	}

	// Idempotency check: re-use any existing attachment whose
	// `_wp_attached_file` meta matches this relative path. Cheaper and
	// more correct than relying on `attachment_url_to_postid` which goes
	// through filtered URLs.
	$existing = get_posts(
		array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'posts_per_page' => 1,
			'fields'         => 'ids',
			'meta_query'     => array(
				array(
					'key'     => '_wp_attached_file',
					'value'   => $rel_path,
					'compare' => '=',
				),
			),
		)
	);

	if ( ! empty( $existing ) ) {
		$post_id   = (int) $existing[0];
		$local_url = trailingslashit( $uploads['baseurl'] ) . $rel_path;
		$results[] = array(
			'sourceUrl' => $source_url,
			'filename'  => $filename,
			'postId'    => $post_id,
			'reused'    => true,
			'localUrl'  => $local_url,
		);
		continue;
	}

	$mime_type = isset( $entry['mimeType'] ) && '' !== $entry['mimeType']
		? (string) $entry['mimeType']
		: ( wp_check_filetype( $filename )['type'] ?: 'application/octet-stream' );

	$title = isset( $entry['title'] ) && '' !== $entry['title']
		? (string) $entry['title']
		: pathinfo( $filename, PATHINFO_FILENAME );

	$attachment = array(
		'guid'           => trailingslashit( $uploads['baseurl'] ) . $rel_path,
		'post_mime_type' => $mime_type,
		'post_title'     => sanitize_text_field( $title ),
		'post_content'   => '',
		'post_status'    => 'inherit',
	);

	$post_id = wp_insert_attachment( $attachment, $abs_path );
	if ( is_wp_error( $post_id ) || ! $post_id ) {
		$errors[] = array(
			'sourceUrl' => $source_url,
			'filename'  => $filename,
			'error'     => is_wp_error( $post_id ) ? $post_id->get_error_message() : 'wp_insert_attachment returned 0',
		);
		continue;
	}

	$metadata = wp_generate_attachment_metadata( $post_id, $abs_path );
	wp_update_attachment_metadata( $post_id, $metadata );

	if ( '' !== $source_url ) {
		update_post_meta( $post_id, '_dla_source_url', $source_url );
	}

	$local_url = trailingslashit( $uploads['baseurl'] ) . $rel_path;
	$results[] = array(
		'sourceUrl' => $source_url,
		'filename'  => $filename,
		'postId'    => (int) $post_id,
		'reused'    => false,
		'localUrl'  => $local_url,
	);
}

// Use a unique sentinel so the parent process can isolate our JSON in
// stdout even if WP echoes notices during the run.
echo "DLA_INSTALL_MEDIA_JSON_BEGIN\n";
echo wp_json_encode(
	array(
		'results' => $results,
		'errors'  => $errors,
	)
);
echo "\nDLA_INSTALL_MEDIA_JSON_END\n";
