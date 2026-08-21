import axios, { type AxiosInstance } from "axios";

export interface UnsplashSearchOptions {
  query: string;
  page?: number;
  perPage?: number;
}

export interface UnsplashPhoto {
  id: string;
  description: string | null;
  urls: { raw: string; full: string; regular: string; small: string; thumb: string };
  links: { html: string };
  user: { name: string; links: { html: string } };
}

interface UnsplashSearchResponse {
  total: number;
  total_pages: number;
  results: UnsplashPhoto[];
}

export class UnsplashClient {
  private readonly http: AxiosInstance;

  constructor(accessKey: string) {
    this.http = axios.create({
      baseURL: "https://api.unsplash.com",
      headers: { Authorization: `Client-ID ${accessKey}` },
      timeout: 15_000,
    });
  }

  async search(options: UnsplashSearchOptions): Promise<UnsplashSearchResponse> {
    const { data } = await this.http.get<UnsplashSearchResponse>("/search/photos", {
      params: {
        query: options.query,
        page: options.page ?? 1,
        per_page: options.perPage ?? 10,
      },
    });
    return data;
  }

  async random(query?: string): Promise<UnsplashPhoto> {
    const { data } = await this.http.get<UnsplashPhoto>("/photos/random", {
      params: query ? { query } : undefined,
    });
    return data;
  }
}

export function createUnsplashClient(accessKey: string): UnsplashClient {
  return new UnsplashClient(accessKey);
}
