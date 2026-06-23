// Minimal ambient declarations for the untyped Cytoscape extensions and the
// VS Code webview bridge, so `tsc` is happy when type-checking the webview entry.
declare module "cytoscape-dagre" {
  const ext: cytoscape.Ext;
  export = ext;
}

declare module "cytoscape-svg" {
  const ext: cytoscape.Ext;
  export = ext;
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
