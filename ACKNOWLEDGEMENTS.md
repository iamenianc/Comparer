# Acknowledgements

Comparer is built on the following open-source projects.

## Runtime dependencies

| Package | License | Purpose |
|---|---|---|
| [express](https://expressjs.com/) | MIT | HTTP server and API routing |
| [diff](https://github.com/kpdecker/jsdiff) | BSD-3-Clause | Line-by-line and structured patch diff computation |
| [chokidar](https://github.com/paulmillr/chokidar) | MIT | Cross-platform filesystem watcher for real-time grid updates |

## Build dependencies

| Package | License | Purpose |
|---|---|---|
| [esbuild](https://esbuild.github.io/) | MIT | Bundles `server.js` into a single file for the SEA build |
| [postject](https://github.com/nicolo-ribaudo/postject) | MIT | Injects the SEA blob into the Node.js binary to produce `comparer.exe` |

## Fonts and icons

| Resource | License | Purpose |
|---|---|---|
| [Material Symbols](https://fonts.google.com/icons) (Google Fonts) | Apache 2.0 | UI icons throughout the app |

## Platform

Comparer targets **Windows 11** and uses the [Node.js Single Executable Applications](https://nodejs.org/api/single-executable-applications.html) (SEA) feature introduced in Node 20 to produce a zero-dependency distributable executable.
