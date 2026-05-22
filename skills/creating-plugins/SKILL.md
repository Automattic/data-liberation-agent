---
name: creating-plugins
description: Guidelines for creating new WordPress plugins from scratch — load this before generating plugin files
disable-model-invocation: true
---

## When to use me

Use this skill when creating a new plugin from scratch.
Do not use this skill when modifying an existing plugin.

## Generating Plugin Instructions

- Always use the current working directory — do not create a subdirectory for the plugin
- Always include the WordPress plugin header comment in the main PHP file
- Always guard with ABSPATH check at the top of every PHP file
- Always guard functions with function_exists() checks
- Always namespace functions and hooks to avoid conflicts (use a unique prefix)
- Never close the final PHP tag in any PHP file
- No spaces before `<?php` opening tag
- Always sanitize input, validate data, escape output, and check user capabilities
- Use WordPress APIs (Options API, Settings API, wpdb, WP_REST) — do not bypass them
- Properly enqueue scripts and styles using wp_enqueue_script() and wp_enqueue_style()
- Make strings translatable using __(), _e(), and esc_html__()
- Do not install or require external dependencies — use only WordPress core APIs

## Plugin File Structure

```
plugin-slug.php        # Main plugin file — plugin header, ABSPATH guard, hooks
includes/              # PHP classes and helper functions (optional)
admin/                 # Admin-specific code and views (optional)
assets/
  css/                 # Stylesheets
  js/                  # JavaScript files
languages/             # Translation files (optional)
readme.txt             # WordPress plugin readme
uninstall.php          # Cleanup on uninstall (optional)
```

## Main Plugin File Header (required)

```php
<?php
/**
 * Plugin Name: Plugin Name
 * Plugin URI: https://example.com
 * Description: Plugin description
 * Version: 1.0.0
 * Requires at least: 6.0
 * Requires PHP: 8.0
 * Author: Author Name
 * Author URI: https://example.com
 * License: GPL v2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: plugin-slug
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}
```

## Key Patterns

- **Activation/Deactivation**: Use register_activation_hook() and register_deactivation_hook() for setup and teardown
- **Admin Pages**: Use add_menu_page() or add_submenu_page() with proper capability checks
- **Settings**: Use the Settings API (register_setting, add_settings_section, add_settings_field) for options pages
- **Custom Post Types**: Register with register_post_type() on the init hook
- **REST API**: Use register_rest_route() for custom endpoints with permission_callback
- **AJAX**: Use wp_ajax_ and wp_ajax_nopriv_ hooks with nonce verification
