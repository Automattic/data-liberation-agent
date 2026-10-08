# Native control baseline state

Native controls have separate current properties and authored reset defaults.
For example, `input.checked=true` with no `checked` attribute matches `:checked`
but not `:default`. Writing a checked attribute would change both `:default` and
`form.reset()`. The same distinction applies to option selection and text values.

`capturePageHtml()` keeps authored attributes and textarea content in a detached
snapshot. Each input, textarea and select carries a JSON
`data-dla-native-control-state` attribute with the following versioned union:

```ts
type NativeControlState =
  | { version: 1; kind: 'input'; type: string; value: string;
      defaultValue: string; checked: boolean; defaultChecked: boolean;
      indeterminate: boolean }
  | { version: 1; kind: 'textarea'; value: string; defaultValue: string }
  | { version: 1; kind: 'select';
      options: Array<{ selected: boolean; defaultSelected: boolean }> }
  | { version: 1; kind: 'file' };
```

Select options are ordered exactly as `HTMLSelectElement.options`, including
optgroups. This represents multiple selection and `selectedIndex=-1`. File
controls are identified without persisting or restoring selected files. Buttons
have attribute-reflected values and require no independent current-state replay.

## Owned replay

`src/lib/native-control-state.ts` owns observation, the typed contract and its
fixed offline interpreter. `wireNativeControlState()` adds one body-end script
marked `data-dla-native-control-runtime`. It restores defaults where a parser
changed them, then restores current properties, clearing radio peers before
selecting observed winners. It preserves browser-native form ownership. Replay
runs once, synchronously before load. Subsequent native activation and reset are
owned by the browser, without replay listeners or CSS predicate substitution.

Both `sanitizeFrozenHtml()` and the final portable exporter reconstruct this
owned code after removing source scripts. A script's marker never grants source
code permission to survive sanitization. The interpreter accepts only the typed
facts appropriate to the native element and assigns fixed native properties;
payloads supply no executable code, selectors, or property names. Source capture
does not modify live control properties, attributes, defaults or form groups.

Current and default textarea values in the contract also retain leading LF
characters across intermediate HTML parsers. Without a consumer of this
contract, markup alone still cannot retain independent current/default facts.

## Consumer contract

A destination that lowers controls into editable blocks must retain the typed
facts on their native controls and implement the same one-time owned property
replay through its view assets. Keep authored defaults as defaults and preserve
form ownership and option ordering. Arbitrary source scripts remain excluded.

The current Blocks Engine authored-input generator retains `dataAttributes`
but has no native-control-state view consumer; its `checked` block attribute
still reflects markup. Authored select and textarea lowering also need explicit
typed-state support. Portable DLA browser/export/frozen verification proves this
contract in DLA; WordPress consumption requires separate downstream verification.

## Browser evidence

`src/lib/screenshot/native-control-state.test.ts` proves the earlier
property-to-attribute regression, independently compares current properties,
defaults, `:default` CSS, option selection and reset, and verifies source markup
is unchanged. It exercises capture, source observations, export, browser replay
and frozen comparison at 390/768/1440 after the fixture origin is shut down.
It also verifies forged runtime scripts are stripped and malformed typed states
cannot change native properties.
