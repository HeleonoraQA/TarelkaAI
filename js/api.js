/**
 * Tarelka — слой запросов к Supabase.
 *
 * Что здесь есть:
 * - вход, регистрация, выход и обновление сессии через Auth REST;
 * - чтение каталога, профиля, плана и покупок;
 * - запись профиля прямым REST и все мутации через готовые RPC api_*;
 * - понятные ошибки без сырых кодов PostgreSQL, URL и токенов.
 *
 * Сессия лежит в отдельном ключе tarelka:auth и не смешивается с
 * прикладным состоянием tarelka:state. Никаких внешних библиотек нет.
 */
(function () {
  'use strict';

  var config = window.TARELKA_CONFIG || {};
  var BASE = String(config.url || '').replace(/\/+$/, '');
  var KEY = String(config.publishableKey || '');
  var AUTH_KEY = 'tarelka:auth';

  var refreshPromise = null;

  /* ---------------------------------------------------------
     Ошибки
     --------------------------------------------------------- */

  function ApiError(kind, message, status) {
    this.name = 'TarelkaApiError';
    this.kind = kind;
    this.message = message;
    this.status = status || 0;
  }

  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function errorFrom(response) {
    var status = response.status;

    if (status === 401) return new ApiError('auth', 'Сессия истекла', status);
    if (status === 403) return new ApiError('permission', 'Недостаточно прав для этого действия', status);
    if (status === 400 || status === 422) {
      return new ApiError('validation', 'Проверьте введённые данные', status);
    }
    if (status >= 500) {
      return new ApiError('server', 'Не удалось выполнить запрос. Попробуйте ещё раз', status);
    }

    return new ApiError('unknown', 'Не удалось выполнить запрос', status);
  }

  /* ---------------------------------------------------------
     Базовый запрос
     --------------------------------------------------------- */

  function isConfigured() {
    return BASE !== '' && KEY !== '';
  }

  function isOnline() {
    return navigator.onLine !== false;
  }

  function readBody(response) {
    if (response.status === 204) return Promise.resolve(null);

    return response.text().then(function (text) {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (error) {
        // Невалидный ответ не должен ломать интерфейс: считаем его пустым.
        return null;
      }
    });
  }

  function request(path, options) {
    if (!isConfigured()) {
      return Promise.reject(new ApiError('config', 'Подключение к серверу не настроено', 0));
    }

    var opts = options || {};
    var headers = {
      apikey: KEY,
      'Content-Type': 'application/json'
    };

    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    if (opts.prefer) headers.Prefer = opts.prefer;

    var settings = {
      method: opts.method || 'GET',
      headers: headers,
      cache: 'no-store'
    };

    if (opts.body !== undefined && opts.body !== null) {
      settings.body = JSON.stringify(opts.body);
    }

    return fetch(BASE + path, settings).then(function (response) {
      return readBody(response).then(function (body) {
        if (response.ok) return body;
        throw errorFrom(response);
      });
    }, function () {
      throw new ApiError('network', 'Нет связи с сервером', 0);
    });
  }

  /* ---------------------------------------------------------
     Сессия
     --------------------------------------------------------- */

  function clearSession() {
    try {
      localStorage.removeItem(AUTH_KEY);
    } catch (error) {
      /* Хранилище недоступно: приложение продолжает работать в памяти. */
    }
  }

  function saveSession(session) {
    try {
      localStorage.setItem(AUTH_KEY, JSON.stringify(session));
    } catch (error) {
      /* Сессия не сохранилась — приложение продолжает работать в памяти. */
    }
  }

  function readSession() {
    var raw;

    try {
      raw = localStorage.getItem(AUTH_KEY);
    } catch (error) {
      return null;
    }

    if (!raw) return null;

    var value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      clearSession();
      return null;
    }

    if (!value || !value.accessToken || !value.refreshToken ||
        !value.user || !value.user.id) {
      clearSession();
      return null;
    }

    return {
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : 0,
      user: {
        id: String(value.user.id),
        email: value.user.email || ''
      }
    };
  }

  function normalizeSession(data, previousUser) {
    var user = data && data.user ? data.user : previousUser;

    return {
      accessToken: data && data.access_token ? data.access_token : '',
      refreshToken: data && data.refresh_token ? data.refresh_token : '',
      expiresAt: Date.now() + (Number(data && data.expires_in) || 3600) * 1000,
      user: {
        id: user && user.id ? String(user.id) : '',
        email: user && user.email ? String(user.email) : ''
      }
    };
  }

  function validSession(session, what) {
    if (!session || !session.accessToken || !session.user || !session.user.id) {
      clearSession();
      throw new ApiError('auth', what || 'Нужно войти снова', 0);
    }
    return session;
  }

  function signIn(email, password) {
    return request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email: email, password: password }
    }).then(function (data) {
      var session = validSession(normalizeSession(data), 'Не удалось войти. Проверьте почту и пароль');
      saveSession(session);
      return session;
    });
  }

  function signUp(email, password) {
    return request('/auth/v1/signup', {
      method: 'POST',
      body: { email: email, password: password }
    }).then(function (data) {
      if (!data || !data.access_token) {
        // Так бывает только при неправильной настройке проекта: подтверждение почты должно быть выключено.
        return { needsConfirmation: true };
      }

      var session = validSession(normalizeSession(data), 'Не удалось зарегистрироваться');
      saveSession(session);
      return session;
    });
  }

  function signOut() {
    var session = readSession();

    var logout = session
      ? request('/auth/v1/logout', { method: 'POST', token: session.accessToken, body: {} })
          .catch(function () { return null; })
      : Promise.resolve(null);

    return logout.then(function () {
      clearSession();
      return true;
    });
  }

  function refresh() {
    if (refreshPromise) return refreshPromise;

    var current = readSession();
    if (!current || !current.refreshToken) {
      clearSession();
      return Promise.reject(new ApiError('auth', 'Нужно войти снова', 0));
    }

    refreshPromise = request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: current.refreshToken }
    }).then(function (data) {
      var next = normalizeSession(data, current.user);
      validSession(next);
      saveSession(next);
      return next;
    }).catch(function (error) {
      // Неудачное обновление всегда возвращает пользователя к экрану входа.
      clearSession();
      throw error;
    });

    var done = refreshPromise.then(function (value) {
      refreshPromise = null;
      return value;
    }, function (error) {
      refreshPromise = null;
      throw error;
    });

    return done;
  }

  function ensureSession() {
    var session = readSession();

    if (!session) {
      return Promise.reject(new ApiError('auth', 'Нужно войти снова', 0));
    }

    // Обновляем за минуту до истечения, чтобы запросы не падали на границе.
    if (session.expiresAt > Date.now() + 60000) {
      return Promise.resolve(session);
    }

    return refresh();
  }

  function authed(path, options) {
    return ensureSession().then(function (session) {
      var opts = {};
      Object.keys(options || {}).forEach(function (key) {
        opts[key] = options[key];
      });
      opts.token = session.accessToken;
      return request(path, opts);
    });
  }

  function rpc(name, args) {
    return authed('/rest/v1/rpc/' + encodeURIComponent(name), {
      method: 'POST',
      body: args || {}
    });
  }

  /* ---------------------------------------------------------
     Каталог
     --------------------------------------------------------- */

  function byNumber(field) {
    return function (left, right) {
      return (Number(left[field]) || 0) - (Number(right[field]) || 0);
    };
  }

  function mapCatalog(rows, departments, ingredients) {
    var ingredientCategories = {};

    (ingredients || []).forEach(function (row) {
      if (row && row.name && row.department_key) {
        ingredientCategories[row.name] = row.department_key;
      }
    });

    var recipes = (rows || []).map(function (row) {
      var steps = (row.recipe_steps || []).slice().sort(byNumber('step_no'));
      var ingredientsList = (row.recipe_ingredients || []).slice().sort(byNumber('position'));

      return {
        id: row.id,
        title: row.title,
        time: Number(row.time) || 0,
        servings: Number(row.servings) || 2,
        tags: (row.recipe_tags || []).map(function (item) { return item.tag_name; }),
        categories: (row.recipe_categories || []).map(function (item) { return item.category_key; }),
        allergens: (row.recipe_allergens || []).map(function (item) { return item.allergen_key; }),
        intro: row.intro || '',
        image: row.image || '',
        ingredients: ingredientsList.map(function (item) {
          return {
            name: item.ingredient_name,
            amount: item.amount === null || item.amount === undefined ? '' : String(item.amount),
            unit: item.unit || ''
          };
        }),
        steps: steps.map(function (item) { return item.body; })
      };
    });

    return {
      recipes: recipes,
      departments: (departments || []).map(function (row) {
        return { key: row.key, title: row.title };
      }),
      ingredientCategories: ingredientCategories
    };
  }

  function getCatalog() {
    var select = 'id,title,time,servings,intro,image,' +
      'recipe_steps(step_no,body),' +
      'recipe_ingredients(ingredient_name,amount,unit,position),' +
      'recipe_tags(tag_name),' +
      'recipe_categories(category_key),' +
      'recipe_allergens(allergen_key)';

    return Promise.all([
      request('/rest/v1/recipes?select=' + encodeURIComponent(select) + '&order=id.asc'),
      request('/rest/v1/departments?select=key,title&order=sort_order.asc'),
      request('/rest/v1/ingredients?select=name,department_key')
    ]).then(function (results) {
      return mapCatalog(results[0], results[1], results[2]);
    });
  }

  /* ---------------------------------------------------------
     Профиль, импорт, план и покупки
     --------------------------------------------------------- */

  function getProfile(userId) {
    return authed(
      '/rest/v1/profiles?select=user_id,onboarded,diet,allergies,people,updated_at&user_id=eq.' +
        encodeURIComponent(userId)
    ).then(function (rows) {
      return rows && rows.length ? rows[0] : null;
    });
  }

  function saveProfile(profile, userId) {
    return authed('/rest/v1/profiles', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: {
        user_id: userId,
        onboarded: profile.onboarded === true,
        diet: profile.diet || 'none',
        allergies: Array.isArray(profile.allergies) ? profile.allergies : [],
        people: Number(profile.people) || 4
      }
    });
  }

  function hasImport(userId) {
    return authed('/rest/v1/imports?select=user_id&user_id=eq.' + encodeURIComponent(userId))
      .then(function (rows) {
        return !!(rows && rows.length);
      });
  }

  function markImport(userId, source) {
    return authed('/rest/v1/imports', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        user_id: userId,
        source: source || 'localStorage v1'
      }
    });
  }

  function getPlan() {
    return rpc('api_get_plan');
  }

  function setPlan(days) {
    return rpc('api_set_plan', { p_days: days });
  }

  function setMeal(day, slot, recipeId) {
    return rpc('api_set_meal', {
      p_day: day,
      p_slot: slot,
      p_recipe_id: recipeId || null
    });
  }

  function getShopping() {
    return rpc('api_get_shopping');
  }

  function addManual(name, amount, dept, source) {
    return rpc('api_add_manual', {
      p_name: name,
      p_amount: amount || '',
      p_dept: dept || 'other',
      p_source: source || 'вручную'
    });
  }

  function removeManual(id) {
    return rpc('api_remove_manual', { p_id: id });
  }

  function setChecked(key, done) {
    return rpc('api_set_checked', { p_key: key, p_done: done !== false });
  }

  function unsetChecked(key) {
    return rpc('api_unset_checked', { p_key: key });
  }

  window.TarelkaApi = {
    AUTH_KEY: AUTH_KEY,
    ApiError: ApiError,
    isConfigured: isConfigured,
    isOnline: isOnline,
    getSession: readSession,
    clearSession: clearSession,
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,
    ensureSession: ensureSession,
    getCatalog: getCatalog,
    getProfile: getProfile,
    saveProfile: saveProfile,
    hasImport: hasImport,
    markImport: markImport,
    getPlan: getPlan,
    setPlan: setPlan,
    setMeal: setMeal,
    getShopping: getShopping,
    addManual: addManual,
    removeManual: removeManual,
    setChecked: setChecked,
    unsetChecked: unsetChecked
  };
})();
