# WordPress core Navigation fixture

Source: **WordPress 6.8.3**, https://wordpress.org/wordpress-6.8.3.zip
(WordPress is licensed GPL-2.0-or-later.)

`index.html` contains the output of `do_blocks()` for
`core/navigation` with `overlayMenu: "mobile"` and `hasIcon: true`, containing
four custom `core/navigation-link` blocks, extended with the authored “Links”
submenu from https://mebenedetto.com/ for #1097 (including its nested
Interactivity API context and bound `aria-expanded`). The original navigation
was rendered with WP-CLI against
an installed, stock WordPress 6.8.3 (no plugins). The page shell adds a stylesheet
link, the core Interactivity API import map/module, and the global `is-layout-flex`
layout rule normally supplied by WordPress; the navigation HTML is not a mock.

Copied verbatim from the release:

- `style.css`: `wp-includes/blocks/navigation/style.css`
- `view.min.js`: `wp-includes/blocks/navigation/view.min.js`
- `interactivity.min.js`: `wp-includes/js/dist/script-modules/interactivity/index.min.js`

The actual core JS runs on the source fixture; only the portable dialog runtime
runs on the copy. No WordPress installation or PHP is required to run the test.

To regenerate the navigation HTML, save this as `render.php`, then run
`wp eval-file render.php` against WordPress 6.8.3 and replace only the `<nav>`
in `index.html` with its output, retaining the additional Links submenu:

```php
<?php
$block = '<!-- wp:navigation {"overlayMenu":"mobile","hasIcon":true} -->';
foreach ( array( 'About', 'Menu', 'Contact', 'Journal' ) as $label ) {
    $block .= '<!-- wp:navigation-link ' . wp_json_encode( array(
        'label' => $label,
        'url' => '#' . strtolower( $label ),
        'kind' => 'custom',
    ) ) . ' /-->';
}
$block .= '<!-- /wp:navigation -->';
echo do_blocks( $block );
```

The browser regression probes this real source on 127.0.0.1 and renders the
captured portable HTML at 390, 768, and 1440px, including repeated resizing and
phone open/Escape-close. It also inspects serialized resting HTML before any
portable runtime executes: opened classes, dialog roles and forced display stay
in replay evidence only. The submenu alone did not defeat `restingInline`
observation on the fixture or the live source when investigated for #1097;
the regression catches the opened-snapshot serialization in the reuse path.
Expected wall time: approximately 2 seconds.
