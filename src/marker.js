// The hidden marker that lets ci-doctor find (and update) its own PR comment.
// Its own module so report.js has no Node-only imports and runs in a browser.
export const MARKER = '<!-- qvac-ci-doctor -->'
