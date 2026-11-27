import { Platform } from "react-native";

import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";

import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

const BASE_URL = process.env.EXPO_PUBLIC_SERVER_BASE_URL;

// ─── 타입 정의 ───────────────────────────────────────
interface TokenPair {
  accessToken: string;
  refreshToken?: string;
}

interface PendingRequest {
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}

// _retry 커스텀 속성을 인식시키기 위한 타입 확장
interface CustomAxiosRequestConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

// ─── 플랫폼별 안전한 스토리지 래퍼 (모바일: SecureStore / 웹: localStorage) ──
const storage = {
  getItem: async (key: string): Promise<string | null> => {
    if (Platform.OS === "web") {
      return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    }
    return SecureStore.getItemAsync(key);
  },
  setItem: async (key: string, value: string): Promise<void> => {
    if (Platform.OS === "web") {
      if (typeof window !== "undefined") window.localStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  deleteItem: async (key: string): Promise<void> => {
    if (Platform.OS === "web") {
      if (typeof window !== "undefined") window.localStorage.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

// ─── 토큰 관리 헬퍼 ──────────────────────────────────
const TokenManager = {
  getAccessToken: (): Promise<string | null> => storage.getItem("accessToken"),

  getRefreshToken: (): Promise<string | null> => storage.getItem("refreshToken"),

  setTokens: async ({ accessToken, refreshToken }: TokenPair): Promise<void> => {
    await storage.setItem("accessToken", accessToken);
    if (refreshToken) {
      await storage.setItem("refreshToken", refreshToken);
    }
  },

  clear: async (): Promise<void> => {
    await storage.deleteItem("accessToken");
    await storage.deleteItem("refreshToken");
  },
};

// ─── Axios 인스턴스 생성 ─────────────────────────────
const publicAPI: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
});

const privateAPI: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
});

// ─── 공통 응답 인터셉터 ──────────────────────────────
const unwrapResponse = (response: AxiosResponse) => response.data;
const handleError = (error: AxiosError) => Promise.reject(error);

publicAPI.interceptors.response.use(unwrapResponse, handleError);

// ─── privateAPI: 요청 인터셉터 ───────────────────────
privateAPI.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const token = await TokenManager.getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ─── privateAPI: 응답 인터셉터 (토큰 갱신 + 재요청) ──
let isRefreshing = false;
let pendingRequests: PendingRequest[] = [];

const processQueue = (error: unknown, token: string | null = null): void => {
  pendingRequests.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
    } else if (token) {
      resolve(token);
    }
  });
  pendingRequests = [];
};

privateAPI.interceptors.response.use(unwrapResponse, async (error: AxiosError) => {
  const originalRequest = error.config as CustomAxiosRequestConfig | undefined;

  if (!originalRequest || error.response?.status !== 401 || originalRequest._retry) {
    return Promise.reject(error);
  }

  if (isRefreshing) {
    return new Promise<string>((resolve, reject) => {
      pendingRequests.push({ resolve, reject });
    }).then((token) => {
      originalRequest.headers.Authorization = `Bearer ${token}`;
      return privateAPI(originalRequest);
    });
  }

  originalRequest._retry = true;
  isRefreshing = true;

  try {
    const currentRefreshToken = await TokenManager.getRefreshToken();

    if (!currentRefreshToken) {
      throw new Error("No refresh token available");
    }

    const { data } = await axios.post<TokenPair>(`${BASE_URL}/auth/refresh`, {
      refreshToken: currentRefreshToken,
    });

    await TokenManager.setTokens(data);
    processQueue(null, data.accessToken);

    originalRequest.headers.Authorization = `Bearer ${data.accessToken}`;
    return privateAPI(originalRequest);
  } catch (refreshError) {
    processQueue(refreshError, null);
    await TokenManager.clear();
    router.replace("/login");
    return Promise.reject(refreshError);
  } finally {
    isRefreshing = false;
  }
});

// ─── 요청 취소 헬퍼 ──────────────────────────────────
export const createCancelToken = (): AbortController => new AbortController();

// ─── 재시도 헬퍼 ─────────────────────────────────────
const withRetry = <T extends (...args: never[]) => Promise<unknown>>(
  fn: T,
  retries = 2,
  delay = 1000
) => {
  return async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return (await fn(...args)) as Awaited<ReturnType<T>>;
      } catch (error) {
        const axiosError = error as AxiosError;
        const isLastAttempt = attempt === retries;
        const isRetryable = !axiosError.response || axiosError.code === "ECONNABORTED";

        if (isLastAttempt || !isRetryable) throw error;
        await new Promise((r) => setTimeout(r, delay * (attempt + 1)));
      }
    }
    throw new Error("Retry failed");
  };
};

export const APIService = {
  public: {
    get: <T = unknown>(url: string, config: AxiosRequestConfig = {}): Promise<T> =>
      publicAPI.get(url, config) as Promise<T>,
    post: <T = unknown>(url: string, data?: unknown, config: AxiosRequestConfig = {}): Promise<T> =>
      publicAPI.post(url, data, config) as Promise<T>,
    put: <T = unknown>(url: string, data?: unknown, config: AxiosRequestConfig = {}): Promise<T> =>
      publicAPI.put(url, data, config) as Promise<T>,
    delete: <T = unknown>(url: string, config: AxiosRequestConfig = {}): Promise<T> =>
      publicAPI.delete(url, config) as Promise<T>,
    patch: <T = unknown>(
      url: string,
      data?: unknown,
      config: AxiosRequestConfig = {}
    ): Promise<T> => publicAPI.patch(url, data, config) as Promise<T>,
  },

  private: {
    get: <T = unknown>(url: string, config: AxiosRequestConfig = {}): Promise<T> =>
      privateAPI.get(url, config) as Promise<T>,
    post: <T = unknown>(url: string, data?: unknown, config: AxiosRequestConfig = {}): Promise<T> =>
      privateAPI.post(url, data, config) as Promise<T>,
    put: <T = unknown>(url: string, data?: unknown, config: AxiosRequestConfig = {}): Promise<T> =>
      privateAPI.put(url, data, config) as Promise<T>,
    delete: <T = unknown>(url: string, config: AxiosRequestConfig = {}): Promise<T> =>
      privateAPI.delete(url, config) as Promise<T>,
    patch: <T = unknown>(
      url: string,
      data?: unknown,
      config: AxiosRequestConfig = {}
    ): Promise<T> => privateAPI.patch(url, data, config) as Promise<T>,
  },

  retry: {
    get: <T = unknown>(url: string, config: AxiosRequestConfig = {}): Promise<T> =>
      withRetry(() => privateAPI.get(url, config) as Promise<T>)(),
    post: <T = unknown>(url: string, data?: unknown, config: AxiosRequestConfig = {}): Promise<T> =>
      withRetry(() => privateAPI.post(url, data, config) as Promise<T>)(),
  },
};

export { publicAPI, privateAPI, TokenManager };
