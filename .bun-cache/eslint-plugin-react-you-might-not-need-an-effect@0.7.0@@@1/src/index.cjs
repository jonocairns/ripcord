// `build.js` will bundle everything into CJS.
// Would be nice to have it use `index.js` directly, but then `esbuild`
// seems unable to structure the CJS export the way ESLint expects.
// Seems we have to unwrap the default export ourselves for that.
module.exports = require("./index.js").default;
