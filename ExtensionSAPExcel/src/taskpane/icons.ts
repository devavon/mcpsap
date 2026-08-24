/**
 * Iconos SVG inline (estilo Fluent, trazo de 1.5) para tipos de entidad y UI.
 * Devuelven cadenas SVG listas para inyectar en innerHTML.
 */

const wrap = (paths: string) =>
  `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** Icono según el "kind" de la entidad del catálogo. */
export function entityIcon(kind: string): string {
  switch (kind) {
    case "master": // socios de negocio
      return wrap(
        `<circle cx="7" cy="6.5" r="2.5"/><path d="M2.5 16c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4"/><path d="M13 5.5a2.2 2.2 0 0 1 0 4.4"/><path d="M14 12.2c2 .4 3.5 1.7 3.5 3.8"/>`,
      );
    case "salesDoc": // documentos de venta
      return wrap(
        `<path d="M5 2.5h6l4 4V17a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 5 17V2.5z"/><path d="M11 2.5V6.5h4"/><path d="M7.5 11.5l2 2 3-3.5"/>`,
      );
    case "purchaseDoc": // documentos de compra
      return wrap(
        `<path d="M2.5 3h2l1.6 8.5a1 1 0 0 0 1 .8h6.4a1 1 0 0 0 1-.8L16.5 6H6"/><circle cx="8" cy="16" r="1"/><circle cx="14" cy="16" r="1"/>`,
      );
    case "payment": // pagos
      return wrap(
        `<rect x="2.5" y="5" width="15" height="10" rx="1.5"/><circle cx="10" cy="10" r="2.2"/><path d="M5 8v4M15 8v4"/>`,
      );
    case "journal": // asientos contables
      return wrap(
        `<path d="M5 3.5h8.5a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H5z"/><path d="M5 3.5a1.5 1.5 0 0 0-1.5 1.5V15A1.5 1.5 0 0 1 5 13.5"/><path d="M7.5 7h4M7.5 9.5h4"/>`,
      );
    default:
      return wrap(`<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M3 8h14M8 8v9"/>`);
  }
}

export const ICONS = {
  gear: wrap(
    `<circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/>`,
  ),
  logout: wrap(`<path d="M8 5V3.5h7.5v13H8V15"/><path d="M11 10H3.5"/><path d="M6 7l-2.5 3L6 13"/>`),
  search: wrap(`<circle cx="8.5" cy="8.5" r="5"/><path d="M12.5 12.5l4 4"/>`),
  table: wrap(`<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M2.5 8h15M8 8v8.5M2.5 12.5h15"/>`),
  download: wrap(`<path d="M10 3v9"/><path d="M6.5 8.5L10 12l3.5-3.5"/><path d="M3.5 15.5h13"/>`),
  chevron: wrap(`<path d="M5.5 8l4.5 4.5L14.5 8"/>`),
  check: wrap(`<path d="M4 10.5l3.5 3.5L16 5.5"/>`),
  refresh: wrap(`<path d="M15.5 6.5A6 6 0 1 0 16 10"/><path d="M15.5 3v3.5H12"/>`),
};
