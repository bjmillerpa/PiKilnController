// WebSocket client with auto-reconnect and event dispatch
export class WsClient extends EventTarget {
  constructor() {
    super();
    this._ws = null;
    this._delay = 1000;
    this._connected = false;
  }

  get connected() { return this._connected; }

  connect(url) {
    // Match the page's protocol: an HTTPS page can't open a ws:// — the
    // browser blocks mixed-content WebSockets silently, and the UI sits
    // there showing "Disconnected" with no error. Use wss:// when we're
    // served over HTTPS (from the relay), ws:// for plain
    // HTTP (the Pi's LAN UI at localhost:8080).
    const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
    this._url = url || `${proto}//${location.host}`;
    this._doConnect();
  }

  _doConnect() {
    const ws = new WebSocket(this._url);

    ws.onopen = () => {
      this._ws = ws;
      this._connected = true;
      this._delay = 1000;
      this.dispatchEvent(new Event('open'));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      } catch { /* ignore bad JSON */ }
    };

    ws.onclose = () => {
      this._ws = null;
      this._connected = false;
      this.dispatchEvent(new Event('close'));
      setTimeout(() => this._doConnect(), this._delay);
      this._delay = Math.min(this._delay * 2, 30000);
    };

    ws.onerror = () => {};
  }

  send(action, params) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'command', action, params }));
    }
  }
}
