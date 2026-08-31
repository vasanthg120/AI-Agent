import axios from 'axios';
import toast from 'react-hot-toast';
import { env } from '@/config/env';
import { useAdminAuthStore } from '@/stores/adminAuthStore';

// A separate axios instance from the customer app's axiosClient — attaches
// the admin session's bearer token instead of the customer session's, so
// the two can never cross-authenticate against each other's routes even
// though they share the same API origin. Mirrors axiosClient.ts's exact
// interceptor pattern (see that file's comments for the reasoning).
export const adminAxiosClient = axios.create({ baseURL: env.apiUrl });

adminAxiosClient.interceptors.request.use((config) => {
  const token = useAdminAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

adminAxiosClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    const wasAuthenticated = useAdminAuthStore.getState().isAuthenticated;
    if (axios.isAxiosError(error) && error.response?.status === 401 && wasAuthenticated) {
      useAdminAuthStore.setState({ admin: null, accessToken: null, isAuthenticated: false });
      toast.error('Your admin session has expired — please sign in again.');
    }
    return Promise.reject(error);
  },
);
