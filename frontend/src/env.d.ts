/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module "tabulator-tables" {
  export * from "tabulator-tables";
  export class TabulatorFull {
    constructor(element: string | HTMLElement, options?: any);
    setData(data: any[]): Promise<void>;
    destroy(): void;
  }
}
