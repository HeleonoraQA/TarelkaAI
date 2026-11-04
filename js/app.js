/**
 * Tarelka — навигация, состояние и логика прототипа.
 *
 * Что здесь есть:
 * - навигация между экранами (data-screen) и шагами онбординга;
 * - профиль в localStorage;
 * - назначение рецепта в ячейку плана 7 x 3;
 * - список покупок, собранный из плана: агрегация, дедупликация, пересчёт порций;
 * - чекбоксы, ручные позиции и их сохранение;
 * - регистрация service worker для офлайна.
 *
 * Хранилище: один ключ tarelka:state, версия 1. Схема — docs/spec.md.
 */
(function () {
  'use strict';

  var data = window.TARELKA;

  var STORAGE_KEY = 'tarelka:state';
  var CORRUPT_KEY = 'tarelka:state:corrupt';
  var STORAGE_VERSION = 1;

  var DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  var MONTHS_GEN = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ];
  var MEALS = [
    { key: 'breakfast', label: 'Завтрак', tag: 'Завтрак' },
    { key: 'lunch', label: 'Обед', tag: 'Обед' },
    { key: 'dinner', label: 'Ужин', tag: 'Ужин' }
  ];
  var DIET_IDS = {
    none: 'diet-none',
    protein: 'diet-protein',
    light: 'diet-light',
    gentle: 'diet-gentle'
  };
  var ALLERGENS = ['gluten', 'nuts', 'milk', 'eggs', 'fish', 'soy'];
  var PEOPLE = [2, 4, 6];

  var APP_VERSION = '1';

  var DIET_LABELS = {
    none: 'Без ограничений',
    protein: 'Много белка',
    light: 'Лёгкое',
    gentle: 'Щадящее'
  };

  // Родительный падеж — для сводки «без глютена и орехов».
  var ALLERGEN_GENITIVE = {
    gluten: 'глютена',
    nuts: 'орехов',
    milk: 'молока',
    eggs: 'яиц',
    fish: 'рыбы',
    soy: 'сои'
  };

  // Экраны «Ещё → …» подсвечивают вкладку «Ещё» в нижней навигации.
  var TAB_BY_SCREEN = {
    prefs: 'more',
    data: 'more',
    about: 'more'
  };

  var recipesById = {};
  data.recipes.forEach(function (recipe) {
    recipesById[recipe.id] = recipe;
  });

  /* ---------------------------------------------------------
     Состояние
     --------------------------------------------------------- */

  var loadProblem = false;
  var state = loadState();

  var screens = Array.prototype.slice.call(document.querySelectorAll('.screen[data-screen]'));
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tabbar [data-nav]'));
  var steps = Array.prototype.slice.call(document.querySelectorAll('[data-step]'));
  var dots = Array.prototype.slice.call(document.querySelectorAll('.progress-dot'));
  var stepCounter = document.querySelector('[data-step-counter]');
  var stepPrevButtons = Array.prototype.slice.call(document.querySelectorAll('[data-step-prev]'));
  var current = 'onboarding';
  var navStack = [];
  var returnFocus = null;
  var stepIndex = 0;
  var pendingSlot = null;
  var activeRecipe = null;
  var toastTimer = null;
  var discoverFilters = { query: '', fast: false, meal: null };

  function emptyDay() {
    return { breakfast: null, lunch: null, dinner: null };
  }

  function withValidId(id) {
    return id && recipesById[id] ? id : null;
  }

  function defaultPlan() {
    return data.plan.map(function (day) {
      var meals = day.meals || day;
      return {
        breakfast: withValidId(meals.breakfast),
        lunch: withValidId(meals.lunch),
        dinner: withValidId(meals.dinner)
      };
    });
  }

  function defaultState() {
    return {
      version: STORAGE_VERSION,
      profile: { onboarded: false, diet: 'none', allergies: [], people: 4 },
      plan: defaultPlan(),
      checked: {},
      manual: [],
      updatedAt: null
    };
  }

  function normalizeDay(value) {
    var meals = value && value.meals ? value.meals : value;
    if (!meals || typeof meals !== 'object') return emptyDay();
    return {
      breakfast: withValidId(meals.breakfast),
      lunch: withValidId(meals.lunch),
      dinner: withValidId(meals.dinner)
    };
  }

  function normalizeState(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.version !== STORAGE_VERSION) return null;

    var profile = value.profile && typeof value.profile === 'object' ? value.profile : {};
    // Старые значения (vegetarian, vegan, pescatarian) больше не поддерживаются:
    // спокойно превращаем их в «Без ограничений», чтобы не терять остальное состояние.
    var diet = DIET_IDS[profile.diet] ? profile.diet : 'none';
    var allergies = Array.isArray(profile.allergies)
      ? profile.allergies.filter(function (item) {
          return ALLERGENS.indexOf(item) !== -1;
        })
      : [];
    var people = PEOPLE.indexOf(profile.people) !== -1 ? profile.people : 4;

    var plan = Array.isArray(value.plan) ? value.plan.slice(0, 7).map(normalizeDay) : [];
    while (plan.length < 7) plan.push(emptyDay());

    var checked = {};
    if (value.checked && typeof value.checked === 'object') {
      Object.keys(value.checked).forEach(function (key) {
        if (value.checked[key] === true) checked[key] = true;
      });
    }

    var manual = Array.isArray(value.manual)
      ? value.manual
          .filter(function (item) {
            return item && typeof item.name === 'string' && item.name.trim() !== '';
          })
          .slice(0, 300)
          .map(function (item, index) {
            return {
              id: typeof item.id === 'string' && item.id ? item.id : 'm' + index,
              name: item.name.slice(0, 80),
              amount: typeof item.amount === 'string' ? item.amount.slice(0, 40) : '',
              dept: data.ingredientCategories[item.name] || item.dept || 'other',
              source: typeof item.source === 'string' ? item.source.slice(0, 40) : 'вручную'
            };
          })
      : [];

    return {
      version: STORAGE_VERSION,
      profile: {
        onboarded: profile.onboarded === true,
        diet: diet,
        allergies: allergies,
        people: people
      },
      plan: plan,
      checked: checked,
      manual: manual,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null
    };
  }

  function backupCorrupt(raw) {
    loadProblem = true;
    try {
      localStorage.setItem(CORRUPT_KEY, raw.slice(0, 100000));
    } catch (error) {
      /* Если и бэкап не записался — просто начинаем с чистого состояния. */
    }
  }

  function loadState() {
    var raw;

    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return defaultState();
    }

    if (!raw) return defaultState();

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      backupCorrupt(raw);
      return defaultState();
    }

    var normalized = normalizeState(parsed);
    if (!normalized) {
      backupCorrupt(raw);
      return defaultState();
    }

    return normalized;
  }

  function saveState() {
    state.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      toast('Не удалось сохранить изменения: хранилище недоступно');
    }
  }

  /* ---------------------------------------------------------
     Помощники
     --------------------------------------------------------- */

  function icon(name, extraClass) {
    return '<svg class="icon' + (extraClass || '') + '" aria-hidden="true" focusable="false">' +
      '<use href="#icon-' + name + '"></use></svg>';
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[character];
    });
  }

  function mealByKey(key) {
    for (var i = 0; i < MEALS.length; i++) {
      if (MEALS[i].key === key) return MEALS[i];
    }
    return null;
  }

  function dayName(index) {
    return DAY_NAMES[index] || '';
  }

  function plural(count, one, few, many) {
    var mod10 = count % 10;
    var mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function servingsText(count) {
    return count + ' ' + plural(count, 'порция', 'порции', 'порций');
  }

  function parseAmount(amount) {
    var value = parseFloat(String(amount === null || amount === undefined ? '' : amount).replace(',', '.'));
    return isFinite(value) ? value : null;
  }

  function formatNumber(value) {
    return String(Math.round(value * 10) / 10).replace('.', ',');
  }

  function roundForUnit(value, unit) {
    if (unit === 'шт' || unit === 'зуб.' || unit === 'банка' || unit === 'ломтика' || unit === 'шт.') {
      return Math.max(1, Math.ceil(value - 1e-9));
    }
    if (unit === 'г' || unit === 'мл') {
      return Math.max(5, Math.round(value / 5) * 5);
    }
    if (unit === 'ст. л.' || unit === 'ч. л.') {
      return Math.max(0.5, Math.round(value * 2) / 2);
    }
    return Math.round(value * 10) / 10;
  }

  function amountForIngredient(recipe, ingredient) {
    var value = parseAmount(ingredient.amount);
    if (value === null) return ingredient.unit || 'по вкусу';

    var factor = state.profile.people / recipe.servings;
    return formatNumber(roundForUnit(value * factor, ingredient.unit)) +
      (ingredient.unit ? ' ' + ingredient.unit : '');
  }

  function weekDays() {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var monday = new Date(today.getTime());
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));

    return DAY_NAMES.map(function (name, index) {
      var date = new Date(monday.getTime());
      date.setDate(monday.getDate() + index);

      return {
        name: name,
        date: date,
        dateText: date.getDate() + ' ' + MONTHS_GEN[date.getMonth()],
        isToday: date.getTime() === today.getTime()
      };
    });
  }

  function weekRangeText(days) {
    var first = days[0].date;
    var last = days[days.length - 1].date;

    if (first.getMonth() === last.getMonth()) {
      return first.getDate() + '–' + last.getDate() + ' ' + MONTHS_GEN[first.getMonth()];
    }

    return first.getDate() + ' ' + MONTHS_GEN[first.getMonth()] +
      ' – ' + last.getDate() + ' ' + MONTHS_GEN[last.getMonth()];
  }

  function toast(message) {
    var element = document.querySelector('[data-toast]');
    if (!element) return;

    element.textContent = message;
    element.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      element.classList.remove('is-visible');
    }, 3200);
  }

  /* ---------------------------------------------------------
     Навигация
     --------------------------------------------------------- */

  function showScreen(name, options) {
    var opts = options || {};
    var next = screens.filter(function (screen) {
      return screen.dataset.screen === name;
    })[0];

    if (!next) return;

    if (opts.track !== false && name !== current) {
      navStack.push(current);
      returnFocus = document.activeElement;
    }

    current = name;

    screens.forEach(function (screen) {
      screen.hidden = screen !== next;
    });

    document.body.dataset.screen = name;
    document.body.classList.toggle('is-locked', name === 'discover');

    if (name === 'more') renderSettings();
    if (name === 'prefs') {
      applyPrefsToForm();
      renderPrefsConflict();
    }
    if (name === 'data') closeResetConfirm(true);

    var activeTab = TAB_BY_SCREEN[name] || name;
    tabs.forEach(function (tab) {
      if (tab.dataset.nav === activeTab) {
        tab.setAttribute('aria-current', 'page');
      } else {
        tab.removeAttribute('aria-current');
      }
    });

    if (name !== 'discover') window.scrollTo(0, 0);

    if (opts.focus !== false) {
      var heading = name === 'onboarding'
        ? next.querySelector('.step-panel:not([hidden]) .step-panel__title')
        : next.querySelector('h1, h2');

      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    }
  }

  function goTo(name) {
    pendingSlot = null;
    navStack.length = 0;
    showScreen(name, { track: false });
  }

  function goBack() {
    var previous = navStack.pop() || 'home';
    showScreen(previous, { track: false });

    if (returnFocus && returnFocus.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = null;
  }

  function focusSlot(slot) {
    if (!slot) return;
    var day = document.querySelector('[data-day-index="' + slot.dayIndex + '"]');
    if (!day) return;

    var chip = day.querySelector('.recipe-chip') || day.querySelector('.slot__empty');
    if (chip) chip.focus();
  }

  /* ---------------------------------------------------------
     Онбординг
     --------------------------------------------------------- */

  function showStep(index, focusTitle) {
    stepIndex = Math.max(0, Math.min(steps.length - 1, index));

    steps.forEach(function (step, i) {
      step.hidden = i !== stepIndex;
    });

    dots.forEach(function (dot, i) {
      dot.classList.toggle('is-current', i === stepIndex);
    });

    if (stepCounter) {
      stepCounter.textContent = 'Шаг ' + (stepIndex + 1) + ' из ' + steps.length;
    }

    stepPrevButtons.forEach(function (button) {
      button.hidden = stepIndex === 0;
    });

    if (focusTitle) {
      var title = steps[stepIndex].querySelector('.step-panel__title');
      if (title) {
        title.setAttribute('tabindex', '-1');
        title.focus({ preventScroll: true });
      }
    }
  }

  function applyProfileToForm() {
    var dietInput = document.getElementById(DIET_IDS[state.profile.diet] || DIET_IDS.none);
    if (dietInput) dietInput.checked = true;

    ALLERGENS.forEach(function (allergen) {
      var input = document.getElementById('allergy-' + allergen);
      if (input) input.checked = state.profile.allergies.indexOf(allergen) !== -1;
    });

    var peopleInput = document.getElementById('people-' + state.profile.people);
    if (peopleInput) peopleInput.checked = true;
  }

  function readProfileForm() {
    var dietInput = document.querySelector('input[name="diet"]:checked');
    var peopleInput = document.querySelector('input[name="people"]:checked');
    var allergies = [];

    Array.prototype.forEach.call(document.querySelectorAll('input[name="allergy"]:checked'), function (input) {
      allergies.push(input.id.replace('allergy-', ''));
    });

    return {
      diet: dietInput && DIET_IDS[dietInput.value] ? dietInput.value : 'none',
      allergies: allergies.filter(function (item) {
        return ALLERGENS.indexOf(item) !== -1;
      }),
      people: peopleInput && PEOPLE.indexOf(Number(peopleInput.value)) !== -1
        ? Number(peopleInput.value)
        : 4
    };
  }

  function finishOnboarding() {
    var form = readProfileForm();
    var firstRun = !state.profile.onboarded;

    state.profile = {
      onboarded: true,
      diet: form.diet,
      allergies: form.allergies,
      people: form.people
    };

    if (firstRun) generatePlan();

    saveState();

    renderPlan();
    renderShopping();

    showScreen('home', { track: false });
    toast('Настройки сохранены');
  }

  /* ---------------------------------------------------------
     План недели
     --------------------------------------------------------- */

  function slotMarkup(day, dayIndex, meal, recipeId) {
    var recipe = recipeId ? recipesById[recipeId] : null;
    var body;

    if (recipe) {
      body = '<div class="slot__body">' +
        '<button class="recipe-chip" type="button" data-open-recipe="' + esc(recipe.id) + '">' +
          '<img class="recipe-chip__img" src="' + esc(recipe.image) + '" alt="" width="48" height="48" loading="lazy">' +
          '<span class="recipe-chip__text">' +
            '<span class="recipe-chip__title">' + esc(recipe.title) + '</span>' +
            '<span class="recipe-chip__meta">' + icon('clock') +
              recipe.time + ' мин · ' + state.profile.people + ' порц.</span>' +
          '</span>' +
        '</button>' +
        '<button class="icon-btn" type="button" data-remove-slot="' + dayIndex + '" data-meal="' + meal.key + '" ' +
          'aria-label="Убрать «' + esc(recipe.title) + '» из плана">' +
          icon('x') +
        '</button>' +
      '</div>';
    } else {
      body = '<button class="slot__empty" type="button" data-open-discover data-day-index="' + dayIndex + '" data-meal="' + meal.key + '" ' +
        'aria-label="Добавить рецепт: ' + day.name + ', ' + meal.label.toLowerCase() + '">' +
        icon('plus') + '<span>Добавить</span>' +
      '</button>';
    }

    return '<div class="slot">' +
      '<p class="slot__meal">' + meal.label + '</p>' +
      body +
    '</div>';
  }

  function renderPlan() {
    var root = document.querySelector('[data-plan]');
    if (!root) return;

    var days = weekDays();
    var range = document.querySelector('[data-week-range]');
    if (range) range.textContent = weekRangeText(days);

    root.innerHTML = days.map(function (day, dayIndex) {
      var planDay = state.plan[dayIndex] || emptyDay();

      return '<article class="day" data-day-index="' + dayIndex + '"' +
          (day.isToday ? ' data-today="true" aria-current="date"' : '') + '>' +
        '<header class="day__header">' +
          '<h2 class="day__name">' + day.name + '</h2>' +
          '<span class="day__date">' + day.dateText + '</span>' +
          (day.isToday ? '<span class="day__today">Сегодня</span>' : '') +
        '</header>' +
        MEALS.map(function (meal) {
          return slotMarkup(day, dayIndex, meal, planDay[meal.key]);
        }).join('') +
      '</article>';
    }).join('');
  }

  function findRecipeSlot(recipeId) {
    for (var dayIndex = 0; dayIndex < state.plan.length; dayIndex++) {
      for (var mealIndex = 0; mealIndex < MEALS.length; mealIndex++) {
        if (state.plan[dayIndex][MEALS[mealIndex].key] === recipeId) {
          return { dayIndex: dayIndex, meal: MEALS[mealIndex].key };
        }
      }
    }
    return null;
  }

  function firstEmptySlot() {
    for (var dayIndex = 0; dayIndex < state.plan.length; dayIndex++) {
      for (var mealIndex = 0; mealIndex < MEALS.length; mealIndex++) {
        if (!state.plan[dayIndex][MEALS[mealIndex].key]) {
          return { dayIndex: dayIndex, meal: MEALS[mealIndex].key };
        }
      }
    }
    return null;
  }

  function assignRecipe(recipeId, slot) {
    if (!slot || !recipesById[recipeId] || !mealByKey(slot.meal)) return false;

    state.plan[slot.dayIndex][slot.meal] = recipeId;
    saveState();
    renderPlan();
    renderShopping();
    return true;
  }

  function removeSlot(dayIndex, meal) {
    var planDay = state.plan[dayIndex];
    if (!planDay || !mealByKey(meal) || !planDay[meal]) return;

    planDay[meal] = null;
    saveState();
    renderPlan();
    renderShopping();

    var button = document.querySelector(
      '.slot__empty[data-day-index="' + dayIndex + '"][data-meal="' + meal + '"]'
    );
    if (button) button.focus({ preventScroll: true });
    toast('Убрали из плана');
  }

  /* ---------------------------------------------------------
     Карточка рецепта
     --------------------------------------------------------- */

  function recipeActionBar(recipe) {
    var secondary = '';

    if (pendingSlot) {
      secondary = '<button class="btn btn--ghost" type="button" data-assign-recipe="' + esc(recipe.id) + '">' +
        'Добавить сюда' +
      '</button>';
    } else if (findRecipeSlot(recipe.id)) {
      secondary = '<button class="btn btn--ghost" type="button" data-remove-recipe="' + esc(recipe.id) + '">' +
        'Убрать из плана</button>';
    } else {
      secondary = '<button class="btn btn--ghost" type="button" data-add-to-plan="' + esc(recipe.id) + '">' +
        'Добавить в план</button>';
    }

    return '<div class="action-bar">' +
      '<button class="btn btn--primary" type="button" data-add-shopping="' + esc(recipe.id) + '">' +
        'Добавить в список</button>' +
      secondary +
    '</div>';
  }

  function renderRecipe(recipe) {
    if (!recipe) return;

    activeRecipe = recipe;

    var root = document.querySelector('[data-recipe]');
    if (!root) return;

    var people = state.profile.people;
    var servingsMarkup = PEOPLE.map(function (count) {
      var id = 'serv-' + count;
      return '<input class="chip__input" type="radio" name="recipe-servings" value="' + count + '" id="' + id + '"' +
        (count === people ? ' checked' : '') + '>' +
        '<label class="chip" for="' + id + '">' + count + '</label>';
    }).join('');

    var ingredientsMarkup = recipe.ingredients.map(function (ingredient) {
      return '<li class="ingredient">' +
        '<span>' + esc(ingredient.name) + '</span>' +
        '<span class="ingredient__amount">' + esc(amountForIngredient(recipe, ingredient)) + '</span>' +
      '</li>';
    }).join('');

    var stepsMarkup = recipe.steps.map(function (step) {
      return '<li class="step"><span>' + esc(step) + '</span></li>';
    }).join('');

    root.innerHTML =
      '<img class="recipe__hero" src="' + esc(recipe.image) + '" alt="Блюдо «' + esc(recipe.title) + '»" width="960" height="540">' +
      '<div class="recipe__body">' +
        '<div>' +
          '<h2 class="recipe__title">' + esc(recipe.title) + '</h2>' +
          '<p class="recipe__intro">' + esc(recipe.intro) + '</p>' +
          '<p class="recipe__meta">' +
            '<span class="meta-item">' + icon('clock') + recipe.time + ' мин</span>' +
            '<span class="meta-item">' + icon('users') + servingsText(people) + '</span>' +
          '</p>' +
          '<p class="recipe__tags">' + esc(recipe.tags.join(' · ')) + '</p>' +
        '</div>' +

        '<section aria-labelledby="recipe-servings-title">' +
          '<h3 class="section-title" id="recipe-servings-title">Порции</h3>' +
          '<div class="chip-group">' + servingsMarkup + '</div>' +
        '</section>' +

        '<section aria-labelledby="recipe-ingredients-title">' +
          '<h3 class="section-title" id="recipe-ingredients-title">Ингредиенты ' +
            '<span class="muted">на ' + servingsText(people) + '</span></h3>' +
          '<ul class="ingredients">' + ingredientsMarkup + '</ul>' +
        '</section>' +

        '<section aria-labelledby="recipe-steps-title">' +
          '<h3 class="section-title" id="recipe-steps-title">Как готовить</h3>' +
          '<ol class="steps">' + stepsMarkup + '</ol>' +
        '</section>' +

        '<p class="disclaimer">Мы исключаем рецепты с выбранными аллергенами, но состав продуктов может меняться. ' +
          'Проверяйте упаковку и состав.</p>' +
      '</div>' +
      recipeActionBar(recipe);
  }

  function openRecipe(recipeId) {
    var recipe = recipesById[recipeId];
    if (!recipe) return;

    renderRecipe(recipe);
    showScreen('recipe');
  }

  /* ---------------------------------------------------------
     Покупки
     --------------------------------------------------------- */

  function buildShopping() {
    var people = state.profile.people;
    var entries = {};
    var order = [];

    state.plan.forEach(function (planDay) {
      MEALS.forEach(function (meal) {
        var recipe = recipesById[planDay[meal.key]];
        if (!recipe) return;

        var factor = people / recipe.servings;

        recipe.ingredients.forEach(function (ingredient) {
          var dept = data.ingredientCategories[ingredient.name] || 'other';
          var key = 'plan|' + dept + '|' + ingredient.name + '|' + ingredient.unit;
          var entry = entries[key];

          if (!entry) {
            entry = entries[key] = {
              key: key,
              name: ingredient.name,
              dept: dept,
              unit: ingredient.unit,
              total: 0,
              hasAmount: false,
              byTaste: false,
              source: 'из плана',
              manualId: null
            };
            order.push(key);
          }

          var value = parseAmount(ingredient.amount);
          if (value === null) {
            entry.byTaste = true;
          } else {
            entry.total += value * factor;
            entry.hasAmount = true;
          }
        });
      });
    });

    state.manual.forEach(function (item) {
      var key = 'manual|' + item.id;
      order.push(key);
      entries[key] = {
        key: key,
        name: item.name,
        dept: item.dept,
        unit: '',
        amountText: item.amount,
        total: 0,
        hasAmount: false,
        byTaste: false,
        source: item.source || 'вручную',
        manualId: item.id
      };
    });

    var groups = data.departments.map(function (dept) {
      return { key: dept.key, title: dept.title, items: [] };
    });
    var groupsByKey = {};
    groups.forEach(function (group) {
      groupsByKey[group.key] = group;
    });

    order.forEach(function (key) {
      var entry = entries[key];
      var amountText;

      if (entry.manualId) {
        amountText = entry.amountText || '';
      } else if (entry.hasAmount) {
        amountText = formatNumber(roundForUnit(entry.total, entry.unit)) +
          (entry.unit ? ' ' + entry.unit : '');
      } else {
        amountText = entry.unit || 'по вкусу';
      }

      (groupsByKey[entry.dept] || groupsByKey.other).items.push({
        key: entry.key,
        name: entry.name,
        dept: entry.dept,
        source: entry.source,
        manualId: entry.manualId,
        amountText: amountText,
        done: state.checked[entry.key] === true
      });
    });

    return groups.filter(function (group) {
      return group.items.length > 0;
    });
  }

  function updateShoppingProgress() {
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.item__checkbox'));
    var total = boxes.length;
    var done = boxes.filter(function (box) {
      return box.checked;
    }).length;
    var text = document.querySelector('[data-shopping-progress]');
    var bar = document.querySelector('[data-shopping-bar]');

    if (text) {
      text.textContent = done + ' из ' + total + ' куплено';
    }

    if (bar) {
      bar.style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
    }

    Array.prototype.forEach.call(document.querySelectorAll('.group'), function (group) {
      var groupBoxes = group.querySelectorAll('.item__checkbox');
      var groupDone = 0;

      Array.prototype.forEach.call(groupBoxes, function (box) {
        if (box.checked) groupDone += 1;
      });

      var counter = group.querySelector('[data-group-count]');
      if (counter) counter.textContent = groupDone + '/' + groupBoxes.length;
    });
  }

  function renderShopping() {
    var root = document.querySelector('[data-shopping]');
    if (!root) return;

    var groups = buildShopping();

    if (!groups.length) {
      root.innerHTML = '<p class="empty">Пока пусто. Добавьте блюда в план или впишите продукт вручную.</p>';
      updateShoppingProgress();
      return;
    }

    root.innerHTML = groups.map(function (group) {
      var items = group.items.map(function (item, index) {
        var id = 'item-' + group.key + '-' + index;
        var remove = item.manualId
          ? '<button class="icon-btn item__remove" type="button" data-remove-manual="' + esc(item.manualId) + '" ' +
              'aria-label="Удалить «' + esc(item.name) + '» из списка">' + icon('x') + '</button>'
          : '';

        return '<li class="item">' +
          '<label class="item__check">' +
            '<input class="item__checkbox" type="checkbox" id="' + id + '" data-key="' + esc(item.key) + '"' +
              (item.done ? ' checked' : '') + '>' +
            '<span class="visually-hidden">Купить</span>' +
          '</label>' +
          '<span class="item__text">' +
            '<label class="item__label" for="' + id + '">' + esc(item.name) + '</label>' +
            '<span class="item__source">' + esc(item.source) + '</span>' +
          '</span>' +
          '<span class="item__amount">' + esc(item.amountText) + '</span>' +
          remove +
        '</li>';
      }).join('');

      var done = group.items.filter(function (item) {
        return item.done;
      }).length;

      return '<section class="group group--' + group.key + '">' +
        '<h2 class="group__title">' +
          '<span class="group__dot" aria-hidden="true"></span>' + group.title +
          '<span class="group__count" data-group-count="' + group.key + '">' +
            done + '/' + group.items.length +
          '</span>' +
        '</h2>' +
        '<ul>' + items + '</ul>' +
      '</section>';
    }).join('');

    updateShoppingProgress();
  }

  function addManualItem(name) {
    var clean = name.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!clean) return false;

    state.manual.push({
      id: 'm' + Date.now() + Math.floor(Math.random() * 1000),
      name: clean,
      amount: '',
      dept: data.ingredientCategories[clean] || 'other',
      source: 'вручную'
    });
    saveState();
    renderShopping();
    return true;
  }

  function addRecipeToShopping(recipe) {
    var existingNames = {};
    buildShopping().forEach(function (group) {
      group.items.forEach(function (item) {
        existingNames[item.name] = true;
      });
    });

    var added = 0;

    recipe.ingredients.forEach(function (ingredient) {
      if (existingNames[ingredient.name]) return;

      existingNames[ingredient.name] = true;
      state.manual.push({
        id: 'm' + Date.now() + Math.floor(Math.random() * 1000) + added,
        name: ingredient.name,
        amount: amountForIngredient(recipe, ingredient),
        dept: data.ingredientCategories[ingredient.name] || 'other',
        source: 'из рецепта'
      });
      added += 1;
    });

    if (!added) {
      toast('Эти продукты уже есть в списке');
      return;
    }

    saveState();
    renderShopping();
    toast('Добавили в список: ' + added + ' ' + plural(added, 'позицию', 'позиции', 'позиций'));
  }

  function removeManualItem(id) {
    var before = state.manual.length;
    state.manual = state.manual.filter(function (item) {
      return item.id !== id;
    });

    if (state.manual.length === before) return;

    delete state.checked['manual|' + id];
    saveState();
    renderShopping();
    toast('Убрали из списка');
  }

  /* ---------------------------------------------------------
     Discover
     --------------------------------------------------------- */

  function matchesProfile(recipe, profile) {
    if (profile.diet !== 'none' && recipe.categories.indexOf(profile.diet) === -1) {
      return false;
    }

    return profile.allergies.every(function (allergen) {
      return recipe.allergens.indexOf(allergen) === -1;
    });
  }

  function isRecipeAllowed(recipe) {
    return matchesProfile(recipe, state.profile);
  }

  function filteredRecipes() {
    var query = discoverFilters.query.trim().toLowerCase();

    return data.recipes.filter(function (recipe) {
      if (!isRecipeAllowed(recipe)) return false;
      if (discoverFilters.fast && recipe.time > 20) return false;

      if (discoverFilters.meal) {
        var meal = mealByKey(discoverFilters.meal);
        if (meal && recipe.tags.indexOf(meal.tag) === -1) return false;
      }

      if (query) {
        var haystack = recipe.title.toLowerCase() + ' ' + recipe.ingredients.map(function (ingredient) {
          return ingredient.name.toLowerCase();
        }).join(' ');
        if (haystack.indexOf(query) === -1) return false;
      }

      return true;
    });
  }

  function renderPicks() {
    var root = document.querySelector('[data-picks]');
    var empty = document.querySelector('[data-picks-empty]');
    if (!root) return;

    var recipes = filteredRecipes();

    root.innerHTML = recipes.map(function (recipe) {
      return '<li class="pick">' +
        '<button class="pick__button" type="button" data-open-recipe="' + esc(recipe.id) + '">' +
          '<img class="pick__img" src="' + esc(recipe.image) + '" alt="" width="56" height="56" loading="lazy">' +
          '<span class="pick__text">' +
            '<span class="pick__title">' + esc(recipe.title) + '</span>' +
            '<span class="pick__meta">' + icon('clock') +
              recipe.time + ' мин · ' + servingsText(state.profile.people) + '</span>' +
          '</span>' +
        '</button>' +
        '<button class="btn btn--soft btn--sm pick__add" type="button" data-add-pick="' + esc(recipe.id) + '" ' +
          'aria-label="Добавить «' + esc(recipe.title) + '»">' + icon('plus', ' icon--sm') + '</button>' +
      '</li>';
    }).join('');

    if (empty) empty.hidden = recipes.length > 0;
  }

  function syncFilterChips() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (chip) {
      var value = chip.dataset.filter;
      var pressed = value === 'fast' ? discoverFilters.fast : discoverFilters.meal === value;
      chip.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
  }

  function openDiscover(dayIndex, meal) {
    pendingSlot = { dayIndex: dayIndex, meal: meal };
    discoverFilters = { query: '', fast: false, meal: null };

    var search = document.getElementById('discover-search');
    if (search) search.value = '';

    var title = document.getElementById('discover-title');
    var mealInfo = mealByKey(meal);
    if (title && mealInfo) {
      title.textContent = 'Добавить в ' + dayName(dayIndex) + ', ' + mealInfo.label.toLowerCase();
    }

    syncFilterChips();
    renderPicks();
    showScreen('discover');
  }

  function closeDiscover() {
    var previous = navStack.length ? navStack[navStack.length - 1] : 'home';

    pendingSlot = null;

    if (previous === 'recipe') {
      goBack();
      return;
    }

    navStack.length = 0;
    showScreen('home', { track: false });
  }

  function generatePlan() {
    var allowed = data.recipes.filter(isRecipeAllowed);

    state.plan = DAY_NAMES.map(function () {
      var day = {};
      var used = [];

      MEALS.forEach(function (meal) {
        var candidates = allowed.filter(function (recipe) {
          return recipe.tags.indexOf(meal.tag) !== -1;
        });

        if (!candidates.length) candidates = allowed;

        var pool = candidates.filter(function (recipe) {
          return used.indexOf(recipe.id) === -1;
        });
        if (!pool.length) pool = candidates;

        if (!pool.length) {
          day[meal.key] = null;
          return;
        }

        var pick = pool[Math.floor(Math.random() * pool.length)];
        used.push(pick.id);
        day[meal.key] = pick.id;
      });

      return day;
    });
  }

  function regeneratePlan() {
    if (!window.confirm('Собрать план заново? Текущие блюда заменятся.')) return;

    generatePlan();
    saveState();
    renderPlan();
    renderShopping();
    renderPrefsConflict();
    toast('План обновлён');
  }

  /* ---------------------------------------------------------
     Ещё: предпочтения, данные, о продукте
     --------------------------------------------------------- */

  function joinRu(parts) {
    if (parts.length <= 1) return parts.join('');
    return parts.slice(0, -1).join(', ') + ' и ' + parts[parts.length - 1];
  }

  function renderVersion() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-app-version]'), function (element) {
      element.textContent = APP_VERSION;
    });
  }

  function renderSettings() {
    var summary = document.querySelector('[data-prefs-summary]');
    if (!summary) return;

    var parts = [DIET_LABELS[state.profile.diet] || DIET_LABELS.none];

    if (state.profile.allergies.length) {
      parts.push('без ' + joinRu(state.profile.allergies.map(function (allergen) {
        return ALLERGEN_GENITIVE[allergen] || allergen;
      })));
    }

    parts.push(state.profile.people + ' ' +
      plural(state.profile.people, 'человек', 'человека', 'человек'));

    summary.textContent = parts.join(' · ');
  }

  function applyPrefsToForm() {
    var dietInput = document.querySelector(
      'input[name="pref-diet"][value="' + state.profile.diet + '"]'
    );
    if (dietInput) dietInput.checked = true;

    ALLERGENS.forEach(function (allergen) {
      var input = document.getElementById('pref-allergy-' + allergen);
      if (input) input.checked = state.profile.allergies.indexOf(allergen) !== -1;
    });

    var peopleInput = document.getElementById('pref-people-' + state.profile.people);
    if (peopleInput) peopleInput.checked = true;
  }

  function readPrefsForm() {
    var dietInput = document.querySelector('input[name="pref-diet"]:checked');
    var peopleInput = document.querySelector('input[name="pref-people"]:checked');
    var allergies = [];

    Array.prototype.forEach.call(document.querySelectorAll('input[name="pref-allergy"]:checked'), function (input) {
      allergies.push(input.id.replace('pref-allergy-', ''));
    });

    return {
      diet: dietInput && DIET_LABELS[dietInput.value] ? dietInput.value : 'none',
      allergies: allergies.filter(function (item) {
        return ALLERGENS.indexOf(item) !== -1;
      }),
      people: peopleInput && PEOPLE.indexOf(Number(peopleInput.value)) !== -1
        ? Number(peopleInput.value)
        : 4
    };
  }

  // Есть ли в плане блюда, не подходящие под ограничения (сохранённые или из формы).
  function planConflicts(profile) {
    var prefs = profile || state.profile;

    return state.plan.some(function (day) {
      return MEALS.some(function (meal) {
        var recipe = day[meal.key] ? recipesById[day[meal.key]] : null;
        return recipe ? !matchesProfile(recipe, prefs) : false;
      });
    });
  }

  function renderPrefsConflict(profile) {
    var notice = document.querySelector('[data-prefs-conflict]');
    var conflict = planConflicts(profile);

    if (notice) notice.hidden = !conflict;

    return conflict;
  }

  function savePrefs() {
    var form = readPrefsForm();

    state.profile.diet = form.diet;
    state.profile.allergies = form.allergies;
    state.profile.people = form.people;
    state.profile.onboarded = true;

    saveState();

    renderPlan();
    renderShopping();
    renderSettings();

    if (renderPrefsConflict()) {
      toast('Сохранили: в плане есть блюда с новыми ограничениями');
      return;
    }

    toast('Предпочтения сохранены');
    goBack();
  }

  function openResetConfirm() {
    var panel = document.querySelector('[data-reset-confirm]');
    var trigger = document.querySelector('[data-reset]');
    if (!panel) return;

    panel.hidden = false;

    if (trigger) {
      trigger.hidden = true;
      trigger.setAttribute('aria-expanded', 'true');
    }

    var cancel = panel.querySelector('[data-reset-cancel]');
    if (cancel) cancel.focus({ preventScroll: true });
  }

  function closeResetConfirm(silent) {
    var panel = document.querySelector('[data-reset-confirm]');
    var trigger = document.querySelector('[data-reset]');

    if (panel) panel.hidden = true;

    if (trigger) {
      trigger.hidden = false;
      trigger.setAttribute('aria-expanded', 'false');
      if (!silent) trigger.focus({ preventScroll: true });
    }
  }

  function resetAllData() {
    var panel = document.querySelector('[data-reset-confirm]');
    var buttons = panel
      ? Array.prototype.slice.call(panel.querySelectorAll('button'))
      : [];

    // Кнопки недоступны, чтобы не запустить сброс дважды.
    buttons.forEach(function (button) {
      button.disabled = true;
    });

    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(CORRUPT_KEY);
    } catch (error) {
      buttons.forEach(function (button) {
        button.disabled = false;
      });
      toast('Не удалось сбросить данные. Попробуйте ещё раз');
      return;
    }

    toast('Данные сброшены');

    window.setTimeout(function () {
      window.location.reload();
    }, 900);
  }

  /* ---------------------------------------------------------
     События
     --------------------------------------------------------- */

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    var nav = target.closest('[data-nav]');
    if (nav) {
      event.preventDefault();
      goTo(nav.dataset.nav);
      return;
    }

    if (target.closest('[data-back]')) {
      event.preventDefault();
      if (current === 'discover') {
        closeDiscover();
      } else {
        goBack();
      }
      return;
    }

    var openScreenButton = target.closest('[data-open-screen]');
    if (openScreenButton) {
      event.preventDefault();
      showScreen(openScreenButton.dataset.openScreen);
      return;
    }

    if (target.closest('[data-reset]')) {
      event.preventDefault();
      openResetConfirm();
      return;
    }

    if (target.closest('[data-reset-cancel]')) {
      event.preventDefault();
      closeResetConfirm();
      return;
    }

    if (target.closest('[data-reset-go]')) {
      event.preventDefault();
      resetAllData();
      return;
    }

    if (target.closest('[data-step-next]')) {
      showStep(stepIndex + 1, true);
      return;
    }

    if (target.closest('[data-step-prev]')) {
      showStep(stepIndex - 1, true);
      return;
    }

    if (target.closest('[data-onboarding-done]')) {
      finishOnboarding();
      return;
    }

    if (target.closest('[data-regenerate]')) {
      regeneratePlan();
      return;
    }

    var addPick = target.closest('[data-add-pick]');
    if (addPick) {
      var slot = pendingSlot;

      if (slot && assignRecipe(addPick.dataset.addPick, slot)) {
        pendingSlot = null;
        navStack.length = 0;
        showScreen('home', { track: false, focus: false });
        focusSlot(slot);
        toast('Добавлено: ' + dayName(slot.dayIndex) + ', ' +
          (mealByKey(slot.meal) || MEALS[0]).label.toLowerCase());
      }
      return;
    }

    var emptySlot = target.closest('[data-open-discover]');
    if (emptySlot) {
      openDiscover(Number(emptySlot.dataset.dayIndex), emptySlot.dataset.meal);
      return;
    }

    var removeSlotButton = target.closest('[data-remove-slot]');
    if (removeSlotButton) {
      removeSlot(Number(removeSlotButton.dataset.removeSlot), removeSlotButton.dataset.meal);
      return;
    }

    var recipeButton = target.closest('[data-open-recipe]');
    if (recipeButton) {
      openRecipe(recipeButton.dataset.openRecipe);
      return;
    }

    var assignButton = target.closest('[data-assign-recipe]');
    if (assignButton && pendingSlot) {
      var targetSlot = pendingSlot;

      if (assignRecipe(assignButton.dataset.assignRecipe, targetSlot)) {
        pendingSlot = null;
        navStack.length = 0;
        showScreen('home', { track: false, focus: false });
        focusSlot(targetSlot);
        toast('Добавлено: ' + dayName(targetSlot.dayIndex) + ', ' +
          (mealByKey(targetSlot.meal) || MEALS[0]).label.toLowerCase());
      }
      return;
    }

    var addToPlanButton = target.closest('[data-add-to-plan]');
    if (addToPlanButton) {
      var freeSlot = firstEmptySlot();
      if (!freeSlot) {
        toast('В плане нет свободных ячеек');
        return;
      }

      if (assignRecipe(addToPlanButton.dataset.addToPlan, freeSlot)) {
        showScreen('home', { track: false, focus: false });
        focusSlot(freeSlot);
        toast('Добавлено: ' + dayName(freeSlot.dayIndex) + ', ' +
          (mealByKey(freeSlot.meal) || MEALS[0]).label.toLowerCase());
      }
      return;
    }

    var removeRecipeButton = target.closest('[data-remove-recipe]');
    if (removeRecipeButton) {
      var found = findRecipeSlot(removeRecipeButton.dataset.removeRecipe);
      if (found) {
        state.plan[found.dayIndex][found.meal] = null;
        saveState();
        renderPlan();
        renderShopping();
        renderRecipe(recipesById[removeRecipeButton.dataset.removeRecipe]);
        toast('Убрали из плана');
      }
      return;
    }

    var addShoppingButton = target.closest('[data-add-shopping]');
    if (addShoppingButton) {
      var shoppingRecipe = recipesById[addShoppingButton.dataset.addShopping];
      if (shoppingRecipe) addRecipeToShopping(shoppingRecipe);
      return;
    }

    var removeManualButton = target.closest('[data-remove-manual]');
    if (removeManualButton) {
      removeManualItem(removeManualButton.dataset.removeManual);
      return;
    }

    var filterChip = target.closest('[data-filter]');
    if (filterChip) {
      var filter = filterChip.dataset.filter;

      if (filter === 'fast') {
        discoverFilters.fast = !discoverFilters.fast;
      } else {
        discoverFilters.meal = discoverFilters.meal === filter ? null : filter;
      }

      syncFilterChips();
      renderPicks();
      return;
    }

    if (target.closest('[data-filter-reset]')) {
      discoverFilters = { query: '', fast: false, meal: null };
      var searchField = document.getElementById('discover-search');
      if (searchField) searchField.value = '';
      syncFilterChips();
      renderPicks();
    }
  });

  document.addEventListener('change', function (event) {
    var target = event.target;

    if (target.closest('.item__checkbox')) {
      var box = target.closest('.item__checkbox');
      var key = box.dataset.key;

      if (box.checked) {
        state.checked[key] = true;
      } else {
        delete state.checked[key];
      }

      saveState();
      updateShoppingProgress();
      return;
    }

    if (target.matches('input[name="recipe-servings"]') && activeRecipe) {
      state.profile.people = Number(target.value);
      saveState();

      renderRecipe(activeRecipe);
      renderPlan();
      renderShopping();

      var refreshed = document.getElementById('serv-' + state.profile.people);
      if (refreshed) refreshed.focus();
      toast('Считаем на ' + state.profile.people + ' ' +
        plural(state.profile.people, 'человека', 'человек', 'человек'));
    }
  });

  var discoverSearch = document.getElementById('discover-search');
  if (discoverSearch) {
    discoverSearch.addEventListener('input', function (event) {
      discoverFilters.query = event.target.value;
      renderPicks();
    });
  }

  var addForm = document.querySelector('[data-add-form]');
  if (addForm) {
    addForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = document.getElementById('new-item');
      if (!input) return;

      if (addManualItem(input.value)) {
        input.value = '';
        input.focus();
        toast('Добавили в список покупок');
      } else {
        input.focus();
      }
    });
  }

  var prefsForm = document.querySelector('[data-prefs-form]');
  if (prefsForm) {
    // Предупреждение о конфликте обновляем ещё до сохранения — по значениям формы.
    prefsForm.addEventListener('change', function () {
      renderPrefsConflict(readPrefsForm());
    });

    prefsForm.addEventListener('submit', function (event) {
      event.preventDefault();
      savePrefs();
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && current === 'discover') {
      closeDiscover();
      return;
    }

    if (event.key === 'Escape' && current === 'recipe') {
      goBack();
      return;
    }

    if (event.key === 'Escape' && current === 'data') {
      var resetPanel = document.querySelector('[data-reset-confirm]');
      if (resetPanel && !resetPanel.hidden) {
        closeResetConfirm();
        return;
      }
    }

    if (event.key === 'Escape' && (current === 'prefs' || current === 'data' || current === 'about')) {
      goBack();
      return;
    }

    if (event.key !== 'Tab' || current !== 'discover') return;

    var panel = document.querySelector('.screen[data-screen="discover"] .sheet__panel');
    if (!panel) return;

    var focusable = Array.prototype.filter.call(
      panel.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (element) {
        return element.getClientRects().length > 0;
      }
    );

    if (!focusable.length) return;

    var first = focusable[0];
    var last = focusable[focusable.length - 1];

    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel || document.activeElement.tagName === 'H2')) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  /* ---------------------------------------------------------
     Service worker
     --------------------------------------------------------- */

  if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {
        /* Офлайн-режим недоступен — приложение продолжает работать онлайн. */
      });
    });
  }

  /* ---------------------------------------------------------
     Старт
     --------------------------------------------------------- */

  applyProfileToForm();
  renderVersion();
  renderSettings();
  renderPlan();
  renderShopping();
  renderPicks();
  renderRecipe(data.recipes[0]);
  showStep(0);

  if (state.profile.onboarded) {
    showScreen('home', { track: false, focus: false });
  } else {
    showScreen('onboarding', { track: false, focus: false });
  }

  if (loadProblem) {
    toast('Не удалось прочитать сохранённые данные. Начали с чистого листа');
  }
})();
