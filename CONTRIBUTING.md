# Contributing to Yoofloe for Obsidian

Use Node.js 20 and run `npm ci`. Run `npm run check`, `npm run lint`, `npm test`, and `npm run build` before submitting changes.

The production build packages `calendar-companion/src/main.ts`. Keep `styles.css` and `calendar-companion/styles.css` in sync. Test interface changes in a disposable vault on desktop and mobile. Use synthetic notes and mock the provider in automated tests.

Use the Release workflow from the same commit as the release tag. The workflow verifies the build attestations for `main.js` and `styles.css` before uploading the release assets.
