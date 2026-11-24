/** A custom dropdown page shared by the recorder and helpers-template tests (KI-097). */
/**
 * Like ng-select on qa-bike-quote.bewiser.co.uk (KI-097): the field is `<input role="combobox">`, a click opens a
 * listbox of `role="option"` divs inside the widget, typing narrows it, and the choice shows beside the input.
 */
export const CUSTOM_DROPDOWN = (options: string[], opts: { portal?: boolean; onlyWhenTyped?: boolean; dropsChoice?: boolean; hiddenInput?: boolean; replacesWidget?: boolean } = {}) => `
  <label>When did you buy it?</label>
  <${opts.hiddenInput ? "ng-select style='display:block;width:200px;min-height:30px'" : "div"} class="ng-select" id="month">
    <div class="ng-value-container"><div class="ng-placeholder">Month</div>
      <div class="ng-input"><input id="month-input" role="combobox" aria-autocomplete="list" aria-expanded="false" type="text" autocomplete="off" ${opts.hiddenInput ? 'style="display:none"' : ''}></div>
    </div>
  </${opts.hiddenInput ? "ng-select" : "div"}>
  <script>(() => {
    const OPTIONS = ${JSON.stringify(options)};
    const root = document.getElementById("month");
    const input = document.getElementById("month-input");
    const values = root.querySelector(".ng-value-container");
    let panel = null;
    function render() {
      if (!panel) {
        panel = document.createElement("div");
        panel.setAttribute("role", "listbox");
        panel.id = "month-list";
        (${opts.portal ? "document.body" : "root"}).appendChild(panel);
        ${opts.portal ? 'input.setAttribute("aria-controls", "month-list");' : ""}
      }
      panel.innerHTML = "";
      const typed = input.value.toLowerCase();
      const shown = ${opts.onlyWhenTyped ? "typed ? OPTIONS.filter((o) => o.toLowerCase().includes(typed)) : OPTIONS.slice(0, 3)" : "OPTIONS.filter((o) => o.toLowerCase().includes(typed))"};
      for (const label of shown) {
        const option = document.createElement("div");
        option.setAttribute("role", "option");
        option.innerHTML = "<span>" + label + "</span>";
        option.addEventListener("mousedown", (e) => e.preventDefault());
        option.addEventListener("click", () => choose(label));
        panel.appendChild(option);
      }
      input.setAttribute("aria-expanded", "true");
    }
    function choose(label) {
      panel.remove();
      panel = null;
      input.value = "";
      input.setAttribute("aria-expanded", "false");
      if (${opts.dropsChoice ? "true" : "false"}) return;
      values.querySelector(".ng-placeholder").textContent = "";
      let value = values.querySelector(".ng-value");
      if (!value) { value = document.createElement("div"); value.className = "ng-value"; values.prepend(value); }
      value.textContent = label;
      ${opts.replacesWidget ? 'setTimeout(() => input.remove(), 500); value.textContent = ""; setTimeout(() => { value.textContent = label; }, 600);' : ''}
    }
    ${opts.hiddenInput ? 'root.addEventListener("click", (e) => { if (!e.target.closest("[role=option]")) render(); });' : 'input.addEventListener("click", render);'}
    input.addEventListener("input", render);
  })();</script>`;

export const MONTHS = ["Please Select", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
