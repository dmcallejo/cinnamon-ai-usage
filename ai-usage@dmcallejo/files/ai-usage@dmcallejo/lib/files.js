// Asynchronous file helpers (Cinnamon reviewers reject synchronous I/O).

const Gio = imports.gi.Gio;

function errorWithCode(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

// Resolves with the parsed JSON content of `path`.
// Rejects with an Error whose `code` is "ENOENT" when the file does not exist,
// or "EINVAL" when it is not valid JSON. Other GLib errors (including
// cancellation) are passed through unchanged.
function readJSON(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (source, result) => {
            let text;
            try {
                const [, contents] = source.load_contents_finish(result);
                text = new TextDecoder().decode(contents);
            } catch (e) {
                // GLib.Error.code is read only, so wrap instead of annotating.
                if (e.matches && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    reject(errorWithCode("ENOENT", e.message));
                else
                    reject(e);
                return;
            }
            try {
                resolve(JSON.parse(text));
            } catch (e) {
                reject(errorWithCode("EINVAL", e.message));
            }
        });
    });
}

// Calls `callback` when the file at `path` is created, changed or replaced
// (tools often save by writing a temporary file and renaming it over the
// original). Returns the Gio.FileMonitor; call `cancel()` on it to stop.
function watchFile(path, callback) {
    const monitor = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
    monitor.connect("changed", (m, file, otherFile, eventType) => {
        switch (eventType) {
        case Gio.FileMonitorEvent.CHANGES_DONE_HINT:
        case Gio.FileMonitorEvent.CREATED:
        case Gio.FileMonitorEvent.RENAMED:
        case Gio.FileMonitorEvent.MOVED_IN:
            callback();
            break;
        default:
            break;
        }
    });
    return monitor;
}

module.exports = {readJSON, watchFile};
