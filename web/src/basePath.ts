export const BASE_URL = import.meta.env.BASE_URL;

export function assetUrl(path: string) {
  return `${BASE_URL}${path.replace(/^\/+/, "")}`;
}

export function pageUrl(path = "") {
  return `${BASE_URL}${path.replace(/^\/+/, "")}`;
}
