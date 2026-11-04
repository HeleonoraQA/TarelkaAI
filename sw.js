/**
 * Tarelka — минимальный service worker для офлайна.
 *
 * Стратегии:
 * - навигация: сеть -> кэш (офлайн открываем сохранённую оболочку);
 * - статика: сеть -> кэш, успешный ответ обновляет кэш;
 * - не-GET и чужие origin не трогаем.
 *
 * Сеть в приоритете, чтобы обновления файлов подхватывались без ручной
 * очистки кэша. Офлайн-фолбэк при этом остаётся рабочим.
 *
 * При изменении списка файлов поднимаем CACHE_VERSION — старый кэш удалится.
 */
'use strict';

var CACHE_VERSION = 'tarelka-v3';

var SHELL = [
  './',
  './index.html',
  './manifest.json',
  './styles/tokens.css',
  './styles/main.css',
  './js/data.js',
  './js/app.js',
  './assets/icons/favicon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/recipes/pasta.svg',
  './assets/recipes/soup.svg',
  './assets/recipes/oatmeal.svg',
  './assets/recipes/omelette.svg',
  './assets/recipes/buckwheat.svg',
  './assets/recipes/salad.svg',
  './assets/recipes/salmon.svg',
  './assets/recipes/syrniki.svg',
  './assets/recipes/chicken.svg',
  './assets/recipes/toast.svg',
  './assets/recipes/cod.svg',
  './assets/recipes/rice-porridge.svg',
  './assets/recipes/meatballs.svg',
  './assets/recipes/pumpkin-cream.svg',
  './assets/recipes/baked-apple.svg',
  './assets/recipes/turkey-puree.svg',
  './assets/recipes/zucchini-stew.svg',
  './assets/recipes/tuna-rice.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) {
        return cache.addAll(SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          if (key !== CACHE_VERSION) return caches.delete(key);
          return Promise.resolve();
        }));
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          var copy = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.put('./index.html', copy);
          });
          return response;
        })
        .catch(function () {
          return caches.match('./index.html');
        })
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then(function (response) {
        if (response.ok) {
          var copy = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.put(request, copy);
          });
        }
        return response;
      })
      .catch(function () {
        return caches.match(request);
      })
  );
});
