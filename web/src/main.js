import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');

// PWA：注册 Service Worker（仅生产构建；新版本就绪时广播给页面提示刷新）
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            window.dispatchEvent(new CustomEvent('xdns-sw-update'));
          }
        });
      });
    } catch {
      /* 注册失败不影响使用 */
    }
  });
}
