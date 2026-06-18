import axios from 'axios';

// API 基础地址：通过 Next.js rewrites 代理到后端
const api = axios.create({
  baseURL: '/api',
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
