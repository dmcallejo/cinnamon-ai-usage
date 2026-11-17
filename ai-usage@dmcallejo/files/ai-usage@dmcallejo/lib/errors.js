// Error type thrown by providers. `message` is already translated and is shown
// to the user as is; `kind` lets the applet react (for example, back off on
// rate limiting) without parsing text.
// This file must not use `imports.*` so it can be unit tested under Node.

const ErrorKind = Object.freeze({
    CONFIG: "config",          // missing or unreadable credentials, bad settings
    AUTH: "auth",              // expired or rejected credentials
    RATE_LIMITED: "rate-limited",
    NETWORK: "network",        // connection failures, timeouts
    SERVER: "server",          // unexpected status code or payload
});

class ProviderError extends Error {
    constructor(kind, message) {
        super(message);
        this.name = "ProviderError";
        this.kind = kind;
    }
}

module.exports = {ErrorKind, ProviderError};
