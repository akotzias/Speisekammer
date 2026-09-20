export function zutatKey(name) {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "");
}

let comboboxSeq = 0;

export function createZutatCombobox({ value = null, getZutaten, onSelect, onCreateRequest }) {
  const id = `zcb-${++comboboxSeq}`;

  const wrap = document.createElement("div");
  wrap.className = "zutat-combobox";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "zutat-combobox__input ing-name";
  input.placeholder = "Zutat";
  input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", id);

  const list = document.createElement("ul");
  list.className = "zutat-combobox__list";
  list.id = id;
  list.setAttribute("role", "listbox");
  list.hidden = true;

  wrap.append(input, list);

  let selectedId = null;
  let selectedLabel = "";
  let options = [];
  let activeIndex = -1;

  function zutatById(zid) {
    return (getZutaten() || []).find((z) => z.id === zid) || null;
  }

  function labelFor(zid) {
    return zutatById(zid)?.name ?? "";
  }

  function buildOptions(query) {
    const all = getZutaten() || [];
    const key = zutatKey(query);
    const matches = key ? all.filter((z) => zutatKey(z.name).includes(key)) : all.slice();
    const opts = matches.map((z) => ({ kind: "zutat", zutat: z }));

    const typed = query.trim();
    if (typed && !all.some((z) => zutatKey(z.name) === key)) {
      opts.push({ kind: "create", name: typed });
    }
    return opts;
  }

  function renderList() {
    list.innerHTML = "";
    options.forEach((opt, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.id = `${id}-opt-${i}`;
      li.className = "zutat-combobox__option";
      if (opt.kind === "create") li.classList.add("zutat-combobox__option--create");
      if (i === activeIndex) li.classList.add("is-active");
      li.setAttribute("aria-selected", i === activeIndex ? "true" : "false");

      if (opt.kind === "zutat") {
        const name = document.createElement("span");
        name.textContent = opt.zutat.name;
        li.appendChild(name);
        if (opt.zutat.unit) {
          const unit = document.createElement("span");
          unit.className = "zutat-combobox__unit";
          unit.textContent = opt.zutat.unit;
          li.appendChild(unit);
        }
      } else {
        li.textContent = `+ „${opt.name}" anlegen`;
      }

      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(i);
      });
      list.appendChild(li);
    });

    const hasOptions = options.length > 0;
    list.hidden = !hasOptions;
    input.setAttribute("aria-expanded", hasOptions ? "true" : "false");
    input.setAttribute(
      "aria-activedescendant",
      activeIndex >= 0 ? `${id}-opt-${activeIndex}` : ""
    );
  }

  function open(query) {
    options = buildOptions(query);
    activeIndex = options.length ? 0 : -1;
    renderList();
  }

  function close() {
    options = [];
    activeIndex = -1;
    list.hidden = true;
    list.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function commit(zid, knownName) {
    selectedId = zid;
    selectedLabel = zid ? (labelFor(zid) || knownName || "") : "";
    input.value = selectedLabel;
    input.classList.toggle("is-unresolved", !zid);
    close();
    onSelect?.(zid);
  }

  async function choose(i) {
    const opt = options[i];
    if (!opt) return;
    if (opt.kind === "zutat") {
      commit(opt.zutat.id);
      return;
    }
    close();
    const newId = await onCreateRequest?.(opt.name);
    if (newId) {
      commit(newId, opt.name);
    } else {
      revert();
      input.focus();
    }
  }

  function revert() {
    input.value = selectedId ? (labelFor(selectedId) || selectedLabel) : "";
    input.classList.toggle("is-unresolved", !selectedId);
    close();
  }

  input.addEventListener("input", () => {
    if (selectedId && input.value !== selectedLabel) {
      selectedId = null;
      onSelect?.(null);
    }
    input.classList.toggle("is-unresolved", input.value.trim() !== "");
    open(input.value);
  });

  input.addEventListener("focus", () => open(input.value));

  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== input) revert();
    }, 0);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) { open(input.value); return; }
      if (!options.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + step + options.length) % options.length;
      renderList();
      list.children[activeIndex]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      if (!list.hidden && activeIndex >= 0) {
        e.preventDefault();
        choose(activeIndex);
      }
    } else if (e.key === "Escape") {
      if (!list.hidden) {
        e.preventDefault();
        revert();
      }
    }
  });

  if (value) commit(value);

  return {
    element: wrap,
    input,
    getValue: () => selectedId,
    setValue: (zid) => commit(zid || null),
    refresh: () => {
      if (!selectedId) return;
      const current = zutatById(selectedId);
      if (!current) return;
      selectedLabel = current.name;
      if (document.activeElement !== input) input.value = selectedLabel;
    },
    focus: () => input.focus()
  };
}
