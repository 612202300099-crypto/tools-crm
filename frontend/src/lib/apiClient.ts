import axios from 'axios';
import { io, Socket } from 'socket.io-client';

// Hardcoded for Local VPS Development since we want to drop Supabase completely
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://api-wa.parecustom.com';

const apiClient = axios.create({
    baseURL: `${API_BASE_URL}/api/local`,
    headers: {
        'Content-Type': 'application/json'
    }
});

apiClient.interceptors.request.use((config) => {
    if (typeof window !== 'undefined') {
        const token = localStorage.getItem('access_token');
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
    }
    return config;
});

apiClient.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401 || error.response?.status === 403) {
            if (typeof window !== 'undefined') {
                localStorage.removeItem('access_token');
                window.location.href = '/login';
            }
        }
        return Promise.reject(error);
    }
);

let socket: Socket | null = null;

export const initSocket = (): Socket => {
    if (!socket) {
        socket = io(API_BASE_URL, {
            reconnectionAttempts: 10,
            reconnectionDelay: 2000,
        });
    }
    return socket;
};

export const disconnectSocket = () => {
    if (socket) {
        socket.disconnect();
        socket = null;
    }
};

export default apiClient;
