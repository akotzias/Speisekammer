import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, deleteDoc, setDoc, updateDoc,
  onSnapshot, query, orderBy, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { createZutatCombobox, zutatKey } from "./zutat-combobox.js";

const MENU_SIZE = 3;
const UNIT_OPTIONS = [
  { value: "g", label: "g" },
  { value: "ml", label: "ml" },
  { value: "stk", label: "Stück" },
  { value: "tl", label: "TL" },
  { value: "el", label: "EL" },
  { value: "prise", label: "Prise" }
];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const STYLE_KEY = "speisekammer:style";
// STYLES[0] ist der Standard — auch im Inline-Skript in index.html hinterlegt.
const STYLES = ["markt", "kochbuch", "nukem"];

const styleSelect = document.getElementById("styleSelect");

function applyStyle(name) {
  const style = STYLES.includes(name) ? name : STYLES[0];
  document.documentElement.dataset.style = style;
  styleSelect.value = style;
  try {
    localStorage.setItem(STYLE_KEY, style);
  } catch (err) {
    /* Stil bleibt für diese Sitzung gesetzt, wird nur nicht gespeichert. */
  }
}

let savedStyle = null;
try {
  savedStyle = localStorage.getItem(STYLE_KEY);
} catch (err) {
  /* kein Zugriff auf localStorage — Standardstil */
}
applyStyle(savedStyle);
styleSelect.addEventListener("change", () => applyStyle(styleSelect.value));

// Zutaten-Panel auf- und zuklappen. Der Zustand wird auch vor dem ersten Paint
// im Inline-Skript in index.html gesetzt — Schlüssel dort synchron halten.
const ZUTATEN_KEY = "speisekammer:zutaten";
const zutatenToggle = document.getElementById("zutatenToggle");

function setZutatenOpen(open) {
  if (open) delete document.documentElement.dataset.zutaten;
  else document.documentElement.dataset.zutaten = "closed";
  zutatenToggle.setAttribute("aria-expanded", open ? "true" : "false");
  try {
    localStorage.setItem(ZUTATEN_KEY, open ? "open" : "closed");
  } catch (err) {
    /* Zustand gilt für diese Sitzung, wird nur nicht gespeichert. */
  }
}

setZutatenOpen(document.documentElement.dataset.zutaten !== "closed");
zutatenToggle.addEventListener("click", () => {
  setZutatenOpen(document.documentElement.dataset.zutaten === "closed");
});

const syncIndicator = document.getElementById("syncIndicator");
const syncLabel = syncIndicator.querySelector(".sync-label");

function setSyncState(state, label) {
  syncIndicator.dataset.state = state;
  syncLabel.textContent = label;
}

setSyncState("offline", "verbinde…");
onAuthStateChanged(auth, (user) => {
  if (user) {
    setSyncState("online", "synchronisiert");
    startSubscriptions();
  }
});
signInAnonymously(auth).catch((err) => {
  console.error(err);
  setSyncState("offline", "Verbindung fehlgeschlagen");
});

let recipes = [];
let zutaten = [];
let currentPlan = null;
let recipesById = new Map();
let zutatenById = new Map();
let recipesLoaded = false;
let zutatenLoaded = false;
let planLoaded = false;
let editingId = null;
let editingZutatId = null;

const recipeListEl = document.getElementById("recipeList");
const recipeEmptyEl = document.getElementById("recipeEmpty");
const recipeCountEl = document.getElementById("recipeCount");
const menuListEl = document.getElementById("menuList");
const planEmptyEl = document.getElementById("planEmpty");
const shoppingListEl = document.getElementById("shoppingList");
const shoppingEmptyEl = document.getElementById("shoppingEmpty");
const marktHeadingEl = document.getElementById("marktHeading");
const marktListEl = document.getElementById("marktList");
const generateBtn = document.getElementById("generateBtn");
const backupBtn = document.getElementById("backupBtn");

const addRecipeDetails = document.getElementById("addRecipeDetails");
const recipeForm = document.getElementById("recipeForm");
const recipeNameInput = document.getElementById("recipeName");
const ingredientsEditor = document.getElementById("ingredientsEditor");
const addIngredientRowBtn = document.getElementById("addIngredientRow");
const cancelRecipeBtn = document.getElementById("cancelRecipe");

const zutatenListEl = document.getElementById("zutatenList");
const zutatEmptyEl = document.getElementById("zutatEmpty");
const zutatCountEl = document.getElementById("zutatCount");
const zutatForm = document.getElementById("zutatForm");
const zutatNameInput = document.getElementById("zutatName");
const zutatUnitSelect = document.getElementById("zutatUnit");
const zutatMarktInput = document.getElementById("zutatMarkt");
const zutatSubmitBtn = document.getElementById("zutatSubmit");
const zutatCancelBtn = document.getElementById("zutatCancel");

let subscribed = false;
function startSubscriptions() {
  if (subscribed) return;
  subscribed = true;

  const recipesQuery = query(collection(db, "recipes"), orderBy("name"));
  onSnapshot(recipesQuery, (snap) => {
    recipes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    recipesById = new Map(recipes.map((r) => [r.id, r]));
    recipesLoaded = true;
    renderRecipes();
    renderZutaten();
    renderPlan();
    renderShoppingList();
    updateGenerateAvailability();
    updateBackupAvailability();
  }, (err) => console.error("recipes onSnapshot", err));

  onSnapshot(collection(db, "zutaten"), (snap) => {
    zutaten = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));
    zutatenById = new Map(zutaten.map((z) => [z.id, z]));
    zutatenLoaded = true;
    renderZutaten();
    renderRecipes();
    renderShoppingList();
    refreshIngredientRows();
    updateBackupAvailability();
  }, (err) => console.error("zutaten onSnapshot", err));

  onSnapshot(doc(db, "plan", "current"), (snap) => {
    currentPlan = snap.exists() ? snap.data() : null;
    planLoaded = true;
    renderPlan();
    renderShoppingList();
    updateBackupAvailability();
  }, (err) => console.error("plan onSnapshot", err));
}

function normalizeUnit(unit) {
  const raw = (unit || "").trim();
  const lower = raw.toLowerCase();
  if (["", "keine einheit"].includes(lower)) return "";
  if (["stück", "stueck", "stk"].includes(lower)) return "stk";
  return UNIT_OPTIONS.some((option) => option.value === lower) ? lower : "";
}

function formatUnit(unit) {
  const normalized = normalizeUnit(unit);
  if (!normalized) return "";
  return UNIT_OPTIONS.find((option) => option.value === normalized)?.label || "";
}

function toAmount(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function renderRecipes() {
  recipeCountEl.textContent = recipes.length;
  recipeEmptyEl.style.display = recipes.length ? "none" : "block";
  recipeListEl.innerHTML = "";

  recipes.forEach((r) => {
    const li = document.createElement("li");
    li.className = "recipe-item";

    const row = document.createElement("div");
    row.className = "recipe-item__row";

    const name = document.createElement("span");
    name.className = "recipe-item__name";
    name.textContent = r.name;
    name.style.cursor = "pointer";
    name.addEventListener("click", () => li.classList.toggle("is-open"));

    const count = document.createElement("span");
    count.className = "recipe-item__ing-count";
    const n = (r.ingredients || []).length;
    count.textContent = n === 1 ? "1 Zutat" : `${n} Zutaten`;

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn icon-btn--danger";
    delBtn.setAttribute("aria-label", `${r.name} löschen`);
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", () => {
      if (confirm(`„${r.name}" wirklich löschen?`)) {
        deleteDoc(doc(db, "recipes", r.id)).catch((e) => console.error(e));
      }
    });

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.setAttribute("aria-label", `${r.name} bearbeiten`);
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", () => startEditRecipe(r));

    row.append(name, count, editBtn, delBtn);

    const ingList = document.createElement("ul");
    ingList.className = "recipe-item__ingredients";
    (r.ingredients || []).forEach((ing) => {
      const item = document.createElement("li");
      item.textContent = formatIngredient(ing);
      ingList.appendChild(item);
    });

    li.append(row, ingList);
    recipeListEl.appendChild(li);
  });
}

function formatIngredient(ing) {
  const zutat = zutatenById.get(ing.zutatId);
  const parts = [];
  const amount = toAmount(ing.amount);
  if (amount !== null) parts.push(formatAmount(amount));
  if (!zutat) {
    parts.push("Unbekannte Zutat");
    return parts.join(" ");
  }
  const unit = formatUnit(zutat.unit);
  if (unit) parts.push(unit);
  parts.push(zutat.name);
  return parts.join(" ");
}

function formatAmount(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function renderPlan() {
  menuListEl.innerHTML = "";
  if (!currentPlan || !currentPlan.recipeIds || !currentPlan.recipeIds.length) {
    planEmptyEl.style.display = "block";
    return;
  }
  planEmptyEl.style.display = "none";

  currentPlan.recipeIds.forEach((recipeId) => {
    const li = document.createElement("li");
    li.className = "menu-row";

    const recipeEl = document.createElement("span");
    recipeEl.className = "menu-row__recipe";
    const recipe = recipesById.get(recipeId);
    if (recipe) {
      recipeEl.textContent = recipe.name;
    } else {
      recipeEl.textContent = "Rezept gelöscht";
      recipeEl.classList.add("menu-row__recipe--missing");
    }

    li.appendChild(recipeEl);
    menuListEl.appendChild(li);
  });
}

function renderShoppingList() {
  // Der Snapshot baut die Liste neu auf — sonst springt der Fokus beim Abhaken weg.
  const active = document.activeElement;
  const focusedZutatId = active && active.classList.contains("shopping-item__check")
    ? active.dataset.zutatId
    : null;

  shoppingListEl.innerHTML = "";
  marktListEl.innerHTML = "";
  marktHeadingEl.hidden = true;
  marktListEl.hidden = true;
  if (!currentPlan || !currentPlan.recipeIds || !currentPlan.recipeIds.length) {
    shoppingEmptyEl.style.display = "block";
    return;
  }

  const aggregated = aggregateIngredients(currentPlan.recipeIds);
  if (!aggregated.length) {
    shoppingEmptyEl.style.display = "block";
    return;
  }
  shoppingEmptyEl.style.display = "none";

  const checked = (currentPlan && currentPlan.checked) || {};

  aggregated.forEach((item) => {
    const isChecked = !!checked[item.zutatId];

    const li = document.createElement("li");
    li.className = "shopping-item";
    li.classList.toggle("is-checked", isChecked);

    const label = document.createElement("label");
    label.className = "shopping-item__label";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "shopping-item__check";
    box.checked = isChecked;
    box.dataset.zutatId = item.zutatId;
    box.addEventListener("change", () => {
      li.classList.toggle("is-checked", box.checked);
      setShoppingItemChecked(item.zutatId, box.checked);
    });

    const amt = document.createElement("span");
    amt.className = "amt";
    amt.textContent = item.display;
    const name = document.createElement("span");
    name.className = "shopping-item__name";
    name.textContent = item.name;

    label.append(box, amt, name);
    li.appendChild(label);
    (item.markt ? marktListEl : shoppingListEl).appendChild(li);
  });

  const hasMarkt = marktListEl.children.length > 0;
  marktHeadingEl.hidden = !hasMarkt;
  marktListEl.hidden = !hasMarkt;

  if (focusedZutatId) {
    const restored = document.querySelector(
      `.shopping-item__check[data-zutat-id="${focusedZutatId}"]`
    );
    if (restored) restored.focus();
  }
}

async function setShoppingItemChecked(zutatId, checked) {
  try {
    await updateDoc(doc(db, "plan", "current"), { [`checked.${zutatId}`]: checked });
  } catch (e) {
    console.error(e);
    alert("Der Haken konnte nicht gespeichert werden. Prüft eure Internetverbindung.");
  }
}

function aggregateIngredients(recipeIds) {
  const map = new Map();
  recipeIds.forEach((recipeId) => {
    const recipe = recipesById.get(recipeId);
    if (!recipe) return;
    (recipe.ingredients || []).forEach((ing) => {
      const zutat = zutatenById.get(ing.zutatId);
      if (!zutat) return;

      if (!map.has(ing.zutatId)) {
        map.set(ing.zutatId, {
          zutatId: ing.zutatId,
          name: zutat.name, unit: zutat.unit, markt: !!zutat.markt,
          amount: 0, hasAmount: false, plainCount: 0
        });
      }
      const entry = map.get(ing.zutatId);
      const amount = toAmount(ing.amount);
      if (amount !== null) {
        entry.amount += amount;
        entry.hasAmount = true;
      } else {
        entry.plainCount += 1;
      }
    });
  });

  return Array.from(map.values())
    .map((entry) => {
      const segments = [];
      if (entry.hasAmount) {
        segments.push([formatAmount(entry.amount), formatUnit(entry.unit)].filter(Boolean).join(" "));
      }
      if (entry.plainCount > 0 && (entry.hasAmount || entry.plainCount > 1)) {
        segments.push(`${entry.plainCount}×`);
      }
      const display = segments.length ? segments.join(" + ") : "—";
      return { zutatId: entry.zutatId, name: entry.name, display, markt: entry.markt };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

function updateGenerateAvailability() {
  generateBtn.disabled = recipes.length === 0;
}

function updateBackupAvailability() {
  backupBtn.disabled = !(recipesLoaded && zutatenLoaded && planLoaded);
}

// Firestore-Timestamps werden zu lesbaren ISO-Strings, alles andere bleibt wie es ist.
function toPlain(value) {
  if (value == null) return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]));
  }
  return value;
}

function backupStamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}`;
}

backupBtn.addEventListener("click", () => {
  const now = new Date();
  const payload = toPlain({
    version: 1,
    exportedAt: now.toISOString(),
    projectId: firebaseConfig.projectId,
    recipes,
    zutaten,
    plan: currentPlan ? { id: "current", ...currentPlan } : null
  });

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vorratskammer-${backupStamp(now)}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

generateBtn.addEventListener("click", async () => {
  if (!recipes.length) return;
  generateBtn.disabled = true;
  generateBtn.textContent = "Würfle…";

  const shuffled = recipes.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const recipeIds = shuffled.slice(0, MENU_SIZE).map((r) => r.id);

  try {
    await setDoc(doc(db, "plan", "current"), { recipeIds, checked: {} });
  } catch (e) {
    console.error(e);
    alert("Das Menü konnte nicht gespeichert werden. Prüft eure Internetverbindung.");
  } finally {
    generateBtn.disabled = recipes.length === 0;
    generateBtn.textContent = "Neues Menü würfeln";
  }
});

UNIT_OPTIONS.forEach((option) => {
  const el = document.createElement("option");
  el.value = option.value;
  el.textContent = option.label;
  zutatUnitSelect.appendChild(el);
});

function zutatUsageCount(zutatId) {
  return recipes.filter((r) => (r.ingredients || []).some((i) => i.zutatId === zutatId)).length;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

function findSimilarZutaten(key) {
  return zutaten.filter((z) => {
    const other = zutatKey(z.name);
    if (!other || other === key) return false;
    if (other.length >= 2 && key.length >= 2 && (other.startsWith(key) || key.startsWith(other))) return true;
    return levenshtein(other, key) <= 1;
  });
}

async function createZutat(rawName, unit, markt = false) {
  const name = (rawName || "").trim();
  const key = zutatKey(name);
  if (!key) {
    alert("Bitte einen Zutatennamen eingeben.");
    return null;
  }

  const existing = zutaten.find((z) => zutatKey(z.name) === key);
  if (existing) {
    alert(`„${existing.name}" gibt es schon.`);
    return null;
  }

  const similar = findSimilarZutaten(key);
  if (similar.length) {
    const names = similar.map((z) => `„${z.name}"`).join(", ");
    if (!confirm(`Ähnlich vorhanden: ${names}.\n\n„${name}" trotzdem anlegen?`)) return null;
  }

  try {
    const ref = await addDoc(collection(db, "zutaten"), {
      name,
      nameKey: key,
      unit: normalizeUnit(unit),
      markt: !!markt,
      createdAt: serverTimestamp()
    });
    return ref.id;
  } catch (err) {
    console.error(err);
    alert("Zutat konnte nicht gespeichert werden. Prüft eure Internetverbindung.");
    return null;
  }
}

function repointIngredients(ingredients, sourceId, targetId) {
  const out = [];
  const seen = new Map();
  (ingredients || []).forEach((ing) => {
    const zutatId = ing.zutatId === sourceId ? targetId : ing.zutatId;
    const amount = toAmount(ing.amount);
    const existing = seen.get(zutatId);
    if (existing) {
      existing.amount = existing.amount === null && amount === null
        ? null
        : (existing.amount || 0) + (amount || 0);
    } else {
      const entry = { zutatId, amount };
      seen.set(zutatId, entry);
      out.push(entry);
    }
  });
  return out;
}

async function mergeZutaten(source, target) {
  if (!recipesLoaded) {
    alert("Rezepte sind noch nicht geladen. Bitte kurz warten.");
    return false;
  }

  const affected = recipes.filter((r) =>
    (r.ingredients || []).some((i) => i.zutatId === source.id));

  const lines = [
    affected.length === 0
      ? `\u2022 kein Rezept ist betroffen`
      : `\u2022 ${affected.length === 1 ? "1 Rezept wird" : affected.length + " Rezepte werden"} auf \u201e${target.name}" umgestellt`,
    `\u2022 \u201e${source.name}" wird gel\u00f6scht`
  ];
  if (normalizeUnit(source.unit) !== normalizeUnit(target.unit)) {
    const from = formatUnit(source.unit) || "keine Einheit";
    const to = formatUnit(target.unit) || "keine Einheit";
    lines.push(`\u2022 Achtung: ${from} \u2192 ${to}. Mengen werden NICHT umgerechnet.`);
  }

  if (!confirm(
    `\u201e${source.name}" mit \u201e${target.name}" zusammenf\u00fchren?\n\n${lines.join("\n")}`
  )) return false;

  try {
    const batch = writeBatch(db);
    affected.forEach((r) => {
      batch.update(doc(db, "recipes", r.id), {
        ingredients: repointIngredients(r.ingredients, source.id, target.id)
      });
    });
    batch.delete(doc(db, "zutaten", source.id));
    await batch.commit();
    return true;
  } catch (err) {
    console.error(err);
    alert("Zusammenf\u00fchren fehlgeschlagen. Pr\u00fcft eure Internetverbindung.");
    return false;
  }
}

async function saveZutatEdit(zutatId, rawName, unit, markt) {
  const zutat = zutatenById.get(zutatId);
  if (!zutat) return false;
  if (!recipesLoaded) {
    alert("Rezepte sind noch nicht geladen. Bitte kurz warten.");
    return false;
  }

  const name = (rawName || "").trim();
  const key = zutatKey(name);
  if (!key) {
    alert("Bitte einen Zutatennamen eingeben.");
    return false;
  }

  const clash = zutaten.find((z) => z.id !== zutatId && zutatKey(z.name) === key);
  if (clash) return await mergeZutaten(zutat, clash);

  const nextUnit = normalizeUnit(unit);
  if (nextUnit !== normalizeUnit(zutat.unit)) {
    const used = zutatUsageCount(zutatId);
    if (used > 0) {
      const from = formatUnit(zutat.unit) || "keine Einheit";
      const to = formatUnit(nextUnit) || "keine Einheit";
      const where = used === 1 ? "1 Rezept" : `${used} Rezepten`;
      if (!confirm(
        `Einheit von „${zutat.name}" von ${from} auf ${to} ändern?\n\n` +
        `Die Mengen in ${where} werden NICHT umgerechnet.`
      )) return false;
    }
  }

  try {
    await updateDoc(doc(db, "zutaten", zutatId), { name, nameKey: key, unit: nextUnit, markt: !!markt });
    return true;
  } catch (err) {
    console.error(err);
    alert("Zutat konnte nicht gespeichert werden. Prüft eure Internetverbindung.");
    return false;
  }
}

function deleteZutat(zutat) {
  if (!recipesLoaded) {
    alert("Rezepte sind noch nicht geladen. Bitte kurz warten.");
    return;
  }
  const used = zutatUsageCount(zutat.id);
  if (used > 0) {
    const where = used === 1 ? "1 Rezept" : `${used} Rezepten`;
    alert(`„${zutat.name}" wird in ${where} verwendet und kann nicht gelöscht werden.`);
    return;
  }
  if (!confirm(`„${zutat.name}" wirklich löschen?`)) return;
  if (editingZutatId === zutat.id) resetZutatForm();
  deleteDoc(doc(db, "zutaten", zutat.id)).catch((e) => console.error(e));
}

function renderZutaten() {
  zutatCountEl.textContent = zutaten.length;
  zutatEmptyEl.style.display = zutaten.length ? "none" : "block";
  zutatenListEl.innerHTML = "";

  zutaten.forEach((z) => {
    const li = document.createElement("li");
    li.className = "zutat-item";

    const name = document.createElement("span");
    name.className = "zutat-item__name";
    name.textContent = z.name;

    const unitLabel = formatUnit(z.unit);
    if (unitLabel) {
      const unit = document.createElement("span");
      unit.className = "zutat-item__unit";
      unit.textContent = unitLabel;
      li.appendChild(unit);
    }

    if (z.markt) {
      const markt = document.createElement("span");
      markt.className = "zutat-item__markt";
      markt.textContent = "Markt";
      li.appendChild(markt);
    }

    const used = recipesLoaded ? zutatUsageCount(z.id) : 0;
    const usage = document.createElement("span");
    usage.className = "zutat-item__usage";
    if (!recipesLoaded) {
      usage.classList.add("zutat-item__usage--unused");
      usage.textContent = "…";
    } else if (used === 0) {
      usage.classList.add("zutat-item__usage--unused");
      usage.textContent = "ungenutzt";
    } else {
      usage.textContent = used === 1 ? "1 Rezept" : `${used} Rezepte`;
    }

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.setAttribute("aria-label", `${z.name} bearbeiten`);
    editBtn.textContent = "✎";
    editBtn.disabled = !recipesLoaded;
    editBtn.addEventListener("click", () => startEditZutat(z));

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn icon-btn--danger";
    delBtn.setAttribute("aria-label", `${z.name} löschen`);
    delBtn.textContent = "🗑";
    delBtn.disabled = !recipesLoaded;
    delBtn.addEventListener("click", () => deleteZutat(z));

    li.prepend(name);
    li.append(usage, editBtn, delBtn);
    zutatenListEl.appendChild(li);
  });
}

function resetZutatForm() {
  zutatForm.reset();
  editingZutatId = null;
  zutatSubmitBtn.textContent = "Hinzufügen";
  zutatCancelBtn.hidden = true;
}

function startEditZutat(z) {
  editingZutatId = z.id;
  zutatNameInput.value = z.name || "";
  zutatUnitSelect.value = normalizeUnit(z.unit);
  zutatMarktInput.checked = !!z.markt;
  zutatSubmitBtn.textContent = "Speichern";
  zutatCancelBtn.hidden = false;
  zutatNameInput.focus();
}

zutatCancelBtn.addEventListener("click", resetZutatForm);

zutatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  zutatSubmitBtn.disabled = true;
  try {
    if (editingZutatId) {
      const ok = await saveZutatEdit(
        editingZutatId, zutatNameInput.value, zutatUnitSelect.value, zutatMarktInput.checked
      );
      if (ok) resetZutatForm();
    } else {
      const id = await createZutat(
        zutatNameInput.value, zutatUnitSelect.value, zutatMarktInput.checked
      );
      if (id) resetZutatForm();
    }
  } finally {
    zutatSubmitBtn.disabled = false;
  }
});

function unitInputFor(name) {
  const raw = prompt(
    `Welche Einheit hat „${name}"?\n\nLeer lassen für keine Einheit, sonst: g, ml, Stück, TL, EL, Prise`,
    ""
  );
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const unit = normalizeUnit(trimmed);
  if (!unit) {
    alert(`„${trimmed}" ist keine bekannte Einheit. Erlaubt: g, ml, Stück, TL, EL, Prise — oder leer.`);
    return undefined;
  }
  return unit;
}

function newIngredientRow(ing) {
  const row = document.createElement("div");
  row.className = "ingredient-row";

  const amount = document.createElement("input");
  amount.type = "number";
  amount.step = "0.25";
  amount.min = "0";
  amount.placeholder = "Menge";
  amount.className = "ing-amount";

  const unitDisplay = document.createElement("span");
  unitDisplay.className = "ing-unit-display";

  const combo = createZutatCombobox({
    value: ing?.zutatId ?? null,
    getZutaten: () => zutaten,
    onSelect: (zutatId) => {
      const zutat = zutatId ? zutatenById.get(zutatId) : null;
      unitDisplay.textContent = zutat ? formatUnit(zutat.unit) : "";
    },
    onCreateRequest: async (name) => {
      const unit = unitInputFor(name);
      if (unit === undefined) return null;
      return await createZutat(name, unit);
    }
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "row-remove";
  remove.setAttribute("aria-label", "Zutat entfernen");
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    if (ingredientsEditor.children.length > 1) row.remove();
  });

  row.append(amount, unitDisplay, combo.element, remove);
  row._combo = combo;

  if (ing) {
    const parsed = toAmount(ing.amount);
    amount.value = parsed === null ? "" : parsed;
  }
  return row;
}

function refreshIngredientRows() {
  Array.from(ingredientsEditor.children).forEach((row) => row._combo?.refresh());
}

addIngredientRowBtn.addEventListener("click", () => {
  const row = newIngredientRow();
  ingredientsEditor.appendChild(row);
  row._combo.focus();
});

cancelRecipeBtn.addEventListener("click", () => {
  resetRecipeForm();
  addRecipeDetails.open = false;
});

function resetRecipeForm() {
  recipeForm.reset();
  ingredientsEditor.innerHTML = "";
  ingredientsEditor.appendChild(newIngredientRow());
  editingId = null;
  recipeForm.querySelector('button[type="submit"]').textContent = "Rezept speichern";
}

function startEditRecipe(r) {
  editingId = r.id;
  recipeNameInput.value = r.name || "";
  ingredientsEditor.innerHTML = "";
  const ings = (r.ingredients || []);
  if (ings.length) {
    ings.forEach((ing) => ingredientsEditor.appendChild(newIngredientRow(ing)));
  } else {
    ingredientsEditor.appendChild(newIngredientRow());
  }
  recipeForm.querySelector('button[type="submit"]').textContent = "Änderungen speichern";
  addRecipeDetails.open = true;
  recipeNameInput.focus();
  addRecipeDetails.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

recipeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = recipeNameInput.value.trim();
  if (!name) return;

  const rows = Array.from(ingredientsEditor.querySelectorAll(".ingredient-row"));
  const unresolved = rows.some((row) => !row._combo.getValue() && row._combo.input.value.trim());
  if (unresolved) {
    alert("Mindestens eine Zutat ist nicht aus der Liste gewählt. Bitte auswählen oder neu anlegen.");
    return;
  }

  const ingredients = rows
    .map((row) => ({
      zutatId: row._combo.getValue(),
      amount: toAmount(row.querySelector(".ing-amount").value)
    }))
    .filter((ing) => ing.zutatId);

  if (!ingredients.length) {
    alert("Mindestens eine Zutat auswählen.");
    return;
  }

  const submitBtn = recipeForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    if (editingId) {
      await updateDoc(doc(db, "recipes", editingId), { name, ingredients });
    } else {
      await addDoc(collection(db, "recipes"), {
        name,
        ingredients,
        createdAt: serverTimestamp()
      });
    }
    resetRecipeForm();
    addRecipeDetails.open = false;
  } catch (err) {
    console.error(err);
    alert("Rezept konnte nicht gespeichert werden. Prüft eure Internetverbindung.");
  } finally {
    submitBtn.disabled = false;
  }
});

resetRecipeForm();
resetZutatForm();
updateGenerateAvailability();
