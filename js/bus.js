// App-to-app event bus. Keep this surface tiny — most communication
// belongs on a connector.
export const bus = new EventTarget();
