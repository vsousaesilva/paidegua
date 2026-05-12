/**
 * Stub de tipos para `html-docx-js` — biblioteca sem types oficiais.
 * Convertemos um HTML completo (com `<html><head><body>...`) para um
 * Blob que abre nativo no Word/LibreOffice como `.docx`.
 */
declare module 'html-docx-js/dist/html-docx' {
  export function asBlob(
    html: string,
    options?: { orientation?: 'portrait' | 'landscape'; margins?: Record<string, number> }
  ): Blob;
}

/**
 * Stub mínimo de tipos para `html2pdf.js` — wrapper sobre jsPDF + html2canvas.
 * Aceita um Element/HTMLString e gera/baixa o PDF binário direto.
 */
declare module 'html2pdf.js' {
  interface Html2PdfOptions {
    margin?: number | number[];
    filename?: string;
    image?: { type?: 'jpeg' | 'png'; quality?: number };
    html2canvas?: {
      scale?: number;
      useCORS?: boolean;
      logging?: boolean;
      windowWidth?: number;
      [k: string]: unknown;
    };
    jsPDF?: {
      unit?: 'pt' | 'mm' | 'cm' | 'in';
      format?: string | number[];
      orientation?: 'portrait' | 'landscape';
      [k: string]: unknown;
    };
    pagebreak?: {
      mode?: string | string[];
      /** Seletor CSS dos elementos antes dos quais forçar quebra de página. */
      before?: string | string[];
      /** Seletor CSS dos elementos depois dos quais forçar quebra. */
      after?: string | string[];
      /** Seletor CSS dos elementos cuja quebra interna deve ser evitada (insere break antes se for cortar). */
      avoid?: string | string[];
    };
  }
  interface Html2PdfWorker {
    set(opts: Html2PdfOptions): Html2PdfWorker;
    from(source: string | HTMLElement): Html2PdfWorker;
    save(): Promise<void>;
    outputPdf(type?: 'blob' | 'datauristring'): Promise<Blob | string>;
    toPdf(): Html2PdfWorker;
    then<T>(onFulfilled?: (value: unknown) => T | PromiseLike<T>): Promise<T>;
  }
  function html2pdf(): Html2PdfWorker;
  function html2pdf(source: string | HTMLElement, opts?: Html2PdfOptions): Html2PdfWorker;
  export default html2pdf;
}
