import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, deleteDoc, setDoc, updateDoc,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const DAY_LABELS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const UNIT_OPTIONS = [
  { value: "", label: "keine Einheit" },
  { value: "g", label: "g" },
  { value: "kg", label: "kg" },
  { value: "ml", label: "ml" },
  { value: "l", label: "l" },
  { value: "stk", label: "Stück" }
];

// ---------------------------------------------------------------
// Firebase setup
// ---------------------------------------------------------------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const syncIndicator = document.getElementById("syncIndicator");
const syncLabel = syncIndicator.querySelector(".sync-label");

function setSyncState(state, label) {
  syncIndicator.dataset.state = state;
  syncLabel.textContent = label;
}

if (firebaseConfig.apiKey === "REPLACE_ME") {
  setSyncState("offline", "kein Firebase-Projekt verbunden");
  console.warn(
    "firebase-config.js enthält noch Platzhalter-Werte. " +
    "Siehe README.md, um ein eigenes (kostenloses) Firebase-Projekt zu verbinden."
  );
} else {
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
}

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
let recipes = []; // [{id, name, ingredients:[{name, amount, unit}]}]
let currentPlan = null; // {days:[{label, recipeId, recipeName, ingredients}]}
let editingId = null; // id of the recipe currently being edited, or null when adding

// ---------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------
const recipeListEl = document.getElementById("recipeList");
const recipeEmptyEl = document.getElementById("recipeEmpty");
const recipeCountEl = document.getElementById("recipeCount");
const dayListEl = document.getElementById("dayList");
const planEmptyEl = document.getElementById("planEmpty");
const shoppingListEl = document.getElementById("shoppingList");
const shoppingEmptyEl = document.getElementById("shoppingEmpty");
const generateBtn = document.getElementById("generateBtn");

const addRecipeDetails = document.getElementById("addRecipeDetails");
const recipeForm = document.getElementById("recipeForm");
const recipeNameInput = document.getElementById("recipeName");
const ingredientsEditor = document.getElementById("ingredientsEditor");
const addIngredientRowBtn = document.getElementById("addIngredientRow");
const cancelRecipeBtn = document.getElementById("cancelRecipe");

// ---------------------------------------------------------------
// Firestore subscriptions (started once auth is ready, so the first
// reads carry a valid auth token and don't trip the security rules)
// ---------------------------------------------------------------
let subscribed = false;
function startSubscriptions() {
  if (subscribed) return;
  subscribed = true;

  const recipesQuery = query(collection(db, "recipes"), orderBy("name"));
  onSnapshot(recipesQuery, (snap) => {
    recipes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderRecipes();
    updateGenerateAvailability();
  }, (err) => console.error("recipes onSnapshot", err));

  onSnapshot(doc(db, "plan", "current"), (snap) => {
    currentPlan = snap.exists() ? snap.data() : null;
    renderPlan();
    renderShoppingList();
  }, (err) => console.error("plan onSnapshot", err));
}

// ---------------------------------------------------------------
// Rendering: recipes
// ---------------------------------------------------------------
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
  const parts = [];
  if (ing.amount !== null && ing.amount !== undefined && ing.amount !== "") parts.push(ing.amount);
  const unit = formatUnit(ing.unit);
  if (unit) parts.push(unit);
  parts.push(ing.name);
  return parts.join(" ");
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
  return UNIT_OPTIONS.find((option) => option.value === normalized)?.label || "";
}

// ---------------------------------------------------------------
// Rendering: plan
// ---------------------------------------------------------------
function renderPlan() {
  dayListEl.innerHTML = "";
  if (!currentPlan || !currentPlan.days || !currentPlan.days.length) {
    planEmptyEl.style.display = "block";
    return;
  }
  planEmptyEl.style.display = "none";

  currentPlan.days.forEach((d) => {
    const li = document.createElement("li");
    li.className = "day-row";
    const label = document.createElement("span");
    label.className = "day-row__label";
    label.textContent = d.label;
    const recipe = document.createElement("span");
    recipe.className = "day-row__recipe";
    recipe.textContent = d.recipeName;
    li.append(label, recipe);
    dayListEl.appendChild(li);
  });
}

// ---------------------------------------------------------------
// Rendering: shopping list
// ---------------------------------------------------------------
function renderShoppingList() {
  shoppingListEl.innerHTML = "";
  if (!currentPlan || !currentPlan.days || !currentPlan.days.length) {
    shoppingEmptyEl.style.display = "block";
    return;
  }

  const aggregated = aggregateIngredients(currentPlan.days);
  if (!aggregated.length) {
    shoppingEmptyEl.style.display = "block";
    return;
  }
  shoppingEmptyEl.style.display = "none";

  aggregated.forEach((item) => {
    const li = document.createElement("li");
    const amt = document.createElement("span");
    amt.className = "amt";
    amt.textContent = item.display;
    const name = document.createElement("span");
    name.textContent = item.name;
    li.append(amt, name);
    shoppingListEl.appendChild(li);
  });
}

function aggregateIngredients(days) {
  const map = new Map();
  days.forEach((d) => {
    (d.ingredients || []).forEach((ing) => {
      const name = (ing.name || "").trim();
      if (!name) return;
      const unit = normalizeUnit(ing.unit);
      const key = name.toLowerCase() + "|" + unit.toLowerCase();
      const amount = ing.amount === "" || ing.amount === null || ing.amount === undefined
        ? null
        : parseFloat(ing.amount);

      if (!map.has(key)) {
        map.set(key, { name, unit, amount: 0, hasAmount: false, plainCount: 0 });
      }
      const entry = map.get(key);
      if (amount !== null && !isNaN(amount)) {
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
        const amountStr = Number.isInteger(entry.amount) ? entry.amount : entry.amount.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
        segments.push([amountStr, formatUnit(entry.unit)].filter(Boolean).join(" "));
      }
      if (entry.plainCount > 0 && (entry.hasAmount || entry.plainCount > 1)) {
        segments.push(`${entry.plainCount}×`);
      }
      const display = segments.length ? segments.join(" + ") : "—";
      return { name: entry.name, display };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

// ---------------------------------------------------------------
// Generate week plan
// ---------------------------------------------------------------
function updateGenerateAvailability() {
  generateBtn.disabled = recipes.length === 0;
}

generateBtn.addEventListener("click", async () => {
  if (!recipes.length) return;
  generateBtn.disabled = true;
  generateBtn.textContent = "Würfle…";

  const days = DAY_LABELS.map((label) => {
    const choice = recipes[Math.floor(Math.random() * recipes.length)];
    return {
      label,
      recipeId: choice.id,
      recipeName: choice.name,
      ingredients: choice.ingredients || []
    };
  });

  try {
    await setDoc(doc(db, "plan", "current"), { days });
  } catch (e) {
    console.error(e);
    alert("Der Plan konnte nicht gespeichert werden. Prüft eure Internetverbindung.");
  } finally {
    generateBtn.disabled = recipes.length === 0;
    generateBtn.textContent = "Neuen Wochenplan würfeln";
  }
});

// ---------------------------------------------------------------
// Add recipe form
// ---------------------------------------------------------------
function newIngredientRow(ing) {
  const row = document.createElement("div");
  row.className = "ingredient-row";
  row.innerHTML = `
    <input type="number" step="0.25" min="0" placeholder="Menge" class="ing-amount">
    <select class="ing-unit" aria-label="Einheit">
      ${UNIT_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join("")}
    </select>
    <input type="text" placeholder="Zutat" class="ing-name">
    <button type="button" class="row-remove" aria-label="Zutat entfernen">×</button>
  `;
  if (ing) {
    row.querySelector(".ing-amount").value = ing.amount ?? "";
    row.querySelector(".ing-unit").value = normalizeUnit(ing.unit);
    row.querySelector(".ing-name").value = ing.name ?? "";
  }
  row.querySelector(".row-remove").addEventListener("click", () => {
    if (ingredientsEditor.children.length > 1) row.remove();
  });
  return row;
}

ingredientsEditor.querySelector(".row-remove").addEventListener("click", () => {
  if (ingredientsEditor.children.length > 1) ingredientsEditor.firstElementChild.remove();
});

addIngredientRowBtn.addEventListener("click", () => {
  ingredientsEditor.appendChild(newIngredientRow());
  ingredientsEditor.lastElementChild.querySelector(".ing-name").focus();
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

  const ingredients = Array.from(ingredientsEditor.querySelectorAll(".ingredient-row"))
    .map((row) => ({
      amount: row.querySelector(".ing-amount").value.trim(),
      unit: normalizeUnit(row.querySelector(".ing-unit").value),
      name: row.querySelector(".ing-name").value.trim()
    }))
    .filter((ing) => ing.name);

  if (!ingredients.length) {
    alert("Mindestens eine Zutat mit Namen eintragen.");
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

// init
resetRecipeForm();
updateGenerateAvailability();
