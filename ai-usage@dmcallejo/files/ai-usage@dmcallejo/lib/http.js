// Minimal asynchronous HTTP client on top of libsoup.
// Cinnamon 6 loads libsoup 3; older releases (Mint 21.x) still ship libsoup 2,
// so both APIs are supported.

const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;

const TIMEOUT_SECONDS = 20;
const IS_SOUP_2 = Soup.MAJOR_VERSION === 2;

class HttpClient {
    constructor(userAgent) {
        this._session = new Soup.Session({
            user_agent: userAgent,
            timeout: TIMEOUT_SECONDS,
        });
    }

    // Resolves with {status, json} where `json` is the parsed body or null.
    // Rejects only on transport errors (DNS, TLS, timeout, cancellation).
    getJSON(url, headers, cancellable) {
        const message = Soup.Message.new("GET", url);
        message.request_headers.append("Accept", "application/json");
        for (const [name, value] of Object.entries(headers || {}))
            message.request_headers.append(name, value);

        const send = IS_SOUP_2 ? this._sendSoup2 : this._sendSoup3;
        return send.call(this, message, cancellable).then(({status, text}) => {
            let json = null;
            if (text) {
                try {
                    json = JSON.parse(text);
                } catch (e) {
                    json = null;
                }
            }
            return {status, json};
        });
    }

    _sendSoup3(message, cancellable) {
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const data = bytes ? bytes.get_data() : null;
                    resolve({
                        status: message.get_status(),
                        text: data ? new TextDecoder().decode(data) : "",
                    });
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _sendSoup2(message, cancellable) {
        return new Promise((resolve, reject) => {
            let cancelId = 0;
            if (cancellable) {
                cancelId = cancellable.connect(() => {
                    this._session.cancel_message(message, Soup.Status.CANCELLED);
                });
            }
            this._session.queue_message(message, (session, msg) => {
                if (cancellable && cancelId)
                    cancellable.disconnect(cancelId);
                if (msg.status_code === Soup.Status.CANCELLED) {
                    reject(new Error("Cancelled"));
                    return;
                }
                if (msg.status_code < 100) {
                    reject(new Error(Soup.Status.get_phrase(msg.status_code) || "Network error"));
                    return;
                }
                resolve({status: msg.status_code, text: msg.response_body.data || ""});
            });
        });
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }
}

module.exports = {HttpClient};
