import axios from 'axios';

// API 基础地址：
// - 云端环境：通过 Next.js rewrites 代理到后端，baseURL = /api
// - 桌面端环境：通过本地 HTTP 服务器代理到云端，baseURL = /jlyl
//   （server.ts 的 proxyToCloud 将 /jlyl/* 代理到云端 /api/*）
// - Electron file:// 协议：hostname 为空，需要用 protocol 判断
const isDesktop =
  typeof window !== 'undefined' &&
  (window.location.protocol === 'file:' ||
   window.location.hostname === '127.0.0.1' ||
   window.location.hostname === 'localhost');

const api = axios.create({
  baseURL: isDesktop ? '/jlyl' : '/api',
  timeout: 30000,
});

// 请求拦截器：自动添加 token
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// 响应拦截器：处理 401
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      // 分享页面不跳转（由页面自行处理错误）
      const path = window.location.pathname;
      if (path.startsWith('/share/')) {
        return Promise.reject(error);
      }
      localStorage.removeItem('token');
      localStorage.removeItem('userInfo');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
