Append the WeCom channel import to the channel barrel file without disturbing any existing channel imports.

Invariants:

- Keep the existing header comments intact.
- Do not reorder other channel imports.
- Add exactly one `import './wecom.js';` line.
- The file must remain a pure registration barrel with no runtime logic.
