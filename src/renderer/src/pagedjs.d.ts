declare module 'pagedjs' {
  export interface PagedResult {
    total: number
  }
  export class Previewer {
    preview(content: string, stylesheets: Array<Record<string, string>>, renderTo: HTMLElement): Promise<PagedResult>
  }
}
