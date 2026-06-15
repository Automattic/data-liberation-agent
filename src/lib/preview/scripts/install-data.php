<?php
/**
 * install-data.php — vendored helper invoked by data-install.ts via
 * `studio wp eval-file <this-file> <json-payload-path>`.
 *
 * Inserts the CPT taxonomy terms + content items for the WordPress-driven data
 * path (JS data-mounts → query loops). Idempotent:
 *   - terms matched/created by slug within the taxonomy.
 *   - posts matched by `_dla_item_id` meta (the stable source id); existing
 *     posts are updated in place, never duplicated.
 *
 * Requires the generated CPT mu-plugin to be installed FIRST so the post type +
 * taxonomy are registered when this runs (mu-plugins always load under wp-cli).
 *
 * Payload shape:
 *   {
 *     "cpt": "objet",
 *     "taxonomy": "objet_cat",
 *     "fields": ["price_eur", "dimensions", ...],
 *     "terms":  [ { "slug": "glass", "label": "Glass" }, ... ],
 *     "items":  [ {
 *        "id": "opaline-1965", "title": "...", "content": "...",
 *        "terms": ["glass"], "meta": { "price_eur": 120, ... },
 *        "gallery": [ { "caption": "...", "url": "..." } ]
 *     }, ... ]
 *   }
 *
 * Output: { "inserted": N, "updated": N, "terms": N } or an error object.
 */

// WP-CLI eval-file exposes positional args via $args; fall back to $argv.
$json_path = null;
if ( isset( $args ) && is_array( $args ) && ! empty( $args[0] ) ) {
	$json_path = $args[0];
} elseif ( isset( $argv[1] ) ) {
	$json_path = $argv[1];
}
if ( ! $json_path || ! file_exists( $json_path ) ) {
	echo json_encode( array( 'error' => 'missing JSON payload', 'tried' => $json_path ) );
	exit( 1 );
}

$data = json_decode( file_get_contents( $json_path ), true );
if ( ! is_array( $data ) || empty( $data['cpt'] ) || empty( $data['taxonomy'] ) ) {
	echo json_encode( array( 'error' => 'invalid payload (need cpt + taxonomy)' ) );
	exit( 1 );
}

$cpt    = $data['cpt'];
$tax    = $data['taxonomy'];
$fields = isset( $data['fields'] ) && is_array( $data['fields'] ) ? $data['fields'] : array();

if ( ! post_type_exists( $cpt ) ) {
	echo json_encode( array( 'error' => "post type '$cpt' is not registered — install the CPT mu-plugin first" ) );
	exit( 1 );
}

// 1) Terms (idempotent by slug).
$terms_done = 0;
foreach ( ( isset( $data['terms'] ) ? $data['terms'] : array() ) as $t ) {
	if ( empty( $t['slug'] ) ) { continue; }
	$existing = term_exists( $t['slug'], $tax );
	if ( ! $existing ) {
		$label = isset( $t['label'] ) ? $t['label'] : $t['slug'];
		$res   = wp_insert_term( $label, $tax, array( 'slug' => $t['slug'] ) );
		if ( ! is_wp_error( $res ) ) { $terms_done++; }
	}
}

// 2) Items (idempotent by _dla_item_id).
$inserted = 0;
$updated  = 0;
foreach ( ( isset( $data['items'] ) ? $data['items'] : array() ) as $item ) {
	if ( empty( $item['id'] ) ) { continue; }

	$found = get_posts( array(
		'post_type'        => $cpt,
		'post_status'      => 'any',
		'numberposts'      => 1,
		'fields'           => 'ids',
		'meta_key'         => '_dla_item_id',
		'meta_value'       => $item['id'],
		'suppress_filters' => false,
	) );

	$postarr = array(
		'post_type'    => $cpt,
		'post_status'  => 'publish',
		'post_title'   => isset( $item['title'] ) ? $item['title'] : '',
		'post_content' => isset( $item['content'] ) ? $item['content'] : '',
	);

	if ( ! empty( $found ) ) {
		$postarr['ID'] = (int) $found[0];
		$post_id       = wp_update_post( $postarr, true );
		$is_update     = true;
	} else {
		$post_id   = wp_insert_post( $postarr, true );
		$is_update = false;
	}
	if ( is_wp_error( $post_id ) || ! $post_id ) { continue; }

	update_post_meta( $post_id, '_dla_item_id', $item['id'] );
	if ( isset( $item['gallery'] ) && is_array( $item['gallery'] ) ) {
		update_post_meta( $post_id, '_dla_gallery', $item['gallery'] );
	}
	$meta = isset( $item['meta'] ) && is_array( $item['meta'] ) ? $item['meta'] : array();
	foreach ( $fields as $key ) {
		if ( array_key_exists( $key, $meta ) ) {
			update_post_meta( $post_id, $key, $meta[ $key ] );
		}
	}
	if ( isset( $item['terms'] ) && is_array( $item['terms'] ) ) {
		wp_set_object_terms( $post_id, array_values( $item['terms'] ), $tax, false );
	}

	if ( $is_update ) { $updated++; } else { $inserted++; }
}

echo json_encode( array( 'inserted' => $inserted, 'updated' => $updated, 'terms' => $terms_done ) );
