# MuseClientSDK node.js bindings

This package builds a MuseClientSDK native addon for node.js.

## Preparation

1. Install node.js from an official installer.
2. Install node-gyp with `npm install -g node-gyp` (other package managers may be available, see node-gyp doc).
3. Extract the MuseClientSdk package into this folder (the MuseClientSdk folder must be a sibling of this file).

## Build

Run `npm install --save-dev electron-rebuild node-gyp`

This creates a `package.json` file among other things.

Add this to the created `package.json`:
```
"scripts": {
  "install": "electron-rebuild",
  "rebuild": "electron-rebuild"
}

```

Run `node-gyp rebuild --target=31.2.1 --dist-url=https://electronjs.org/headers`

> target 31.2.1 is printed by process.versions in example.js, change it to the version required by your client application. It should also be listed in the `package.json` of the Electron application.

> NOTE: it helps not to have any spaces in the building path!


## Deploy the native MuseClientSDK node

The following applies to the Electron.js application folder previously initialized with:
```
npm install -g @electron-forge/cli
electron-forge init my-app
```

Copy the built .node addon from `win` or `mac` into the Electron.js application folder.

In the Electron.js application (`main.js` or other main file indicated in `package.json`), initialize the module:
`const MuseSdk = require('path/to/MuseClientSdk.node');`
and use it like in `example.js`


## Test

The following applies to the Electron.js application folder previously initialized with `electron-forge init my-app`.

Run `npm start` to lauch the application.
Run `npm run package` to package it into a native launcher.
Run `npm run make` to package it into a native redistributable containing the launcher.