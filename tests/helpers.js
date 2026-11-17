// Test helpers: emulate the bits of the Cinnamon runtime the pure modules rely on.
const path = require("node:path");

// Cinnamon (through GJS) adds String.prototype.format with printf-like tokens.
if (!String.prototype.format) {
    // eslint-disable-next-line no-extend-native
    String.prototype.format = function (...args) {
        let i = 0;
        return this.replace(/%([sd%])/g, (match, token) => {
            if (token === "%")
                return "%";
            const value = args[i++];
            return token === "d" ? String(Math.trunc(Number(value))) : String(value);
        });
    };
}

const APPLET_DIR = path.join(__dirname, "..", "ai-usage@dmcallejo", "files", "ai-usage@dmcallejo");

function appletRequire(relativePath) {
    return require(path.join(APPLET_DIR, relativePath));
}

const identity = (text) => text;

module.exports = {APPLET_DIR, appletRequire, gettext: identity};
