import axios from 'axios';
export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000/api' });
api.interceptors.request.use(config => { const token = localStorage.getItem('ums_token'); if(token) config.headers.Authorization = `Bearer ${token}`; return config; });
api.interceptors.response.use(r=>r, error=>{ if(error.response?.status===401){localStorage.removeItem('ums_token'); localStorage.removeItem('ums_user');} return Promise.reject(error); });
export const messageOf = (e: unknown) => {
  if (typeof e === 'object' && e && 'response' in e) {
    const response = (e as {response?:{data?:{message?:string}}}).response;
    if (response?.data?.message) return response.data.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong. Please try again.';
};
