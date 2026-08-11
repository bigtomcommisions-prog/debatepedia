let vault = null;
let view = 'vault';
let activeNoteId = null;
let openFolders = new Set();
let submitMode = 'new';
let editTargetId = null;
let graphState = null;
let sidebarQuery = '';


/* ---------------- utils ---------------- */

function uid(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 9);
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}


/* ---------------- API storage ---------------- */

async function loadVault() {
    const data = await apiJson('/api/vault');

    const subs = currentUser
        ? await apiJson('/api/submissions')
        : { submissions: [] };

    vault = {
        notes: Array.isArray(data.notes) ? data.notes : [],
        submissions: Array.isArray(subs.submissions)
            ? subs.submissions
            : []
    };
}

async function saveVault() {
    await loadVault();
}

function allApproved() {
    if (!vault || !Array.isArray(vault.notes)) {
        return [];
    }

    return vault.notes.filter(n => n.status === 'approved');
}

function noteByTitle(title) {
    return allApproved().find(
        n => n.title.toLowerCase() === String(title).trim().toLowerCase()
    );
}

function noteById(id) {
    if (!vault) return null;
    return vault.notes.find(n => n.id === id);
}

function childrenOf(id) {
    return vault.notes.filter(
        n => n.status === 'approved' && n.parentId === id
    );
}


/* ---------------- sorting / hierarchy ---------------- */

const KIND_RANK = {
    topic: 0,
    view: 1,
    summary: 2,
    argument: 3
};

function sortChildren(kids) {
    return kids.slice().sort((a, b) => {
        const kr =
            (KIND_RANK[a.kind] ?? 99) -
            (KIND_RANK[b.kind] ?? 99);

        if (kr !== 0) {
            return kr;
        }

        if (a.kind === 'argument') {
            const rr =
                (a.relation === 'refutation' ? 1 : 0) -
                (b.relation === 'refutation' ? 1 : 0);

            if (rr !== 0) {
                return rr;
            }
        }

        return a.title.localeCompare(b.title);
    });
}

function ancestorChain(note) {
    if (!note) return [];

    const chain = [];
    let current = note.parentId
        ? noteById(note.parentId)
        : null;

    while (current) {
        chain.unshift(current);

        current = current.parentId
            ? noteById(current.parentId)
            : null;
    }

    return chain;
}

function ancestorPath(note) {
    return ancestorChain(note)
        .map(n => n.title)
        .join(' › ');
}

function fullPath(note) {
    const path = ancestorPath(note);

    return path
        ? path + ' › ' + note.title
        : note.title;
}

function expandToNote(note) {
    let current = note && note.parentId
        ? noteById(note.parentId)
        : null;

    while (current) {
        openFolders.add(current.id);

        current = current.parentId
            ? noteById(current.parentId)
            : null;
    }
}


/* ---------------- labels / colours ---------------- */

function chipHTML(kind, relation) {
    if (kind === 'topic') {
        return '<span class="stance-chip chip-topic">Topic</span>';
    }

    if (kind === 'view') {
        return '<span class="stance-chip chip-view">View</span>';
    }

    if (kind === 'summary') {
        return '<span class="stance-chip chip-summary">Summary</span>';
    }

    if (kind === 'argument') {
        const isRefutation = relation === 'refutation';

        return `
            <span class="stance-chip ${isRefutation ? 'con' : 'pro'}">
                ${isRefutation ? 'Refutation' : 'Supporting argument'}
            </span>
        `;
    }

    return '';
}

function kindColor(note) {
    if (note.kind === 'topic') {
        return '#d7b56d';
    }

    if (note.kind === 'view') {
        return '#5fb0a5';
    }

    if (note.kind === 'summary') {
        return '#b9b39a';
    }

    return note.relation === 'refutation'
        ? '#7a86f5'
        : '#e2703a';
}


/* ---------------- markdown + wikilinks ---------------- */

function parseWikilinksHTML(html) {
    return html.replace(
        /\[\[([^\]]+)\]\]/g,
        (match, title) => {
            const target = noteByTitle(title);

            if (target) {
                return `
                    <span
                        class="wikilink"
                        data-nav="${escapeHtml(target.id)}"
                    >${escapeHtml(title)}</span>
                `;
            }

            return `
                <span class="wikilink missing">
                    ${escapeHtml(title)}
                </span>
            `;
        }
    );
}

function renderContentHTML(text) {
    if (!text) {
        return '';
    }

    if (typeof marked === 'undefined') {
        return `<p>${escapeHtml(text)}</p>`;
    }

    let markdownHtml = marked.parse(String(text), {
        breaks: true,
        gfm: true
    });

    markdownHtml = parseWikilinksHTML(markdownHtml);

    if (typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(markdownHtml, {
            ADD_ATTR: ['data-nav']
        });
    }

    return markdownHtml;
}

function findBacklinks(note) {
    if (!note) {
        return [];
    }

    const escapedTitle = note.title.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
    );

    const regex = new RegExp(
        '\\[\\[' + escapedTitle + '\\]\\]',
        'i'
    );

    return allApproved().filter(
        n => n.id !== note.id && regex.test(n.content || '')
    );
}


/* ---------------- FOL validity checker ---------------- */

function normalize(s) {
    return String(s || '')
        .trim()
        .replace(/<->|<=>/g, '↔')
        .replace(/->|=>/g, '→')
        .replace(/!|~/g, '¬')
        .replace(/&&|&/g, '∧')
        .replace(/\|\|/g, '∨')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripOuterParens(s) {
    s = (s || '').trim();

    while (
        s.length > 1 &&
        s[0] === '(' &&
        s[s.length - 1] === ')'
    ) {
        let depth = 0;
        let valid = true;

        for (let i = 0; i < s.length; i++) {
            if (s[i] === '(') {
                depth++;
            } else if (s[i] === ')') {
                depth--;

                if (
                    depth === 0 &&
                    i !== s.length - 1
                ) {
                    valid = false;
                    break;
                }
            }
        }

        if (valid) {
            s = s.slice(1, -1).trim();
        } else {
            break;
        }
    }

    return s;
}

function topLevelSplit(raw, opChar) {
    const s = stripOuterParens(normalize(raw));

    let depth = 0;

    for (let i = 0; i < s.length; i++) {
        const c = s[i];

        if (c === '(') {
            depth++;
        } else if (c === ')') {
            depth--;
        } else if (depth === 0 && c === opChar) {
            return {
                left: s.slice(0, i).trim(),
                right: s.slice(i + 1).trim()
            };
        }
    }

    return null;
}

function atomEq(a, b) {
    return (
        stripOuterParens(normalize(a)).toLowerCase() ===
        stripOuterParens(normalize(b)).toLowerCase()
    );
}

function negOf(raw) {
    const s = stripOuterParens(normalize(raw));

    return s.startsWith('¬')
        ? s.slice(1).trim()
        : '¬' + s;
}

function checkValidity(premisesRaw, conclusionRaw) {
    const premises = (premisesRaw || [])
        .map(p => stripOuterParens(normalize(p)))
        .filter(Boolean);

    const conclusion = stripOuterParens(
        normalize(conclusionRaw || '')
    );

    if (!premises.length || !conclusion) {
        return {
            status: 'unrecognized',
            rule: null
        };
    }

    /* Modus Ponens, Modus Tollens,
       Affirming the Consequent,
       Denying the Antecedent */

    for (const p of premises) {
        const impl = topLevelSplit(p, '→');

        if (!impl) {
            continue;
        }

        for (const q of premises) {
            if (q === p) {
                continue;
            }

            if (
                atomEq(q, impl.left) &&
                atomEq(conclusion, impl.right)
            ) {
                return {
                    status: 'valid',
                    rule: 'Modus Ponens'
                };
            }

            if (
                atomEq(q, impl.right) &&
                atomEq(conclusion, impl.left)
            ) {
                return {
                    status: 'invalid',
                    rule: 'Affirming the Consequent'
                };
            }

            if (
                atomEq(q, negOf(impl.right)) &&
                atomEq(conclusion, negOf(impl.left))
            ) {
                return {
                    status: 'valid',
                    rule: 'Modus Tollens'
                };
            }

            if (
                atomEq(q, negOf(impl.left)) &&
                atomEq(conclusion, negOf(impl.right))
            ) {
                return {
                    status: 'invalid',
                    rule: 'Denying the Antecedent'
                };
            }
        }
    }

    /* Hypothetical Syllogism */

    for (const p of premises) {
        const i1 = topLevelSplit(p, '→');

        if (!i1) {
            continue;
        }

        for (const q of premises) {
            if (q === p) {
                continue;
            }

            const i2 = topLevelSplit(q, '→');

            if (!i2) {
                continue;
            }

            if (
                atomEq(i1.right, i2.left) &&
                atomEq(
                    conclusion,
                    i1.left + ' → ' + i2.right
                )
            ) {
                return {
                    status: 'valid',
                    rule: 'Hypothetical Syllogism'
                };
            }
        }
    }

    /* Disjunctive Syllogism */

    for (const p of premises) {
        const disjunction = topLevelSplit(p, '∨');

        if (!disjunction) {
            continue;
        }

        for (const q of premises) {
            if (q === p) {
                continue;
            }

            if (
                atomEq(q, negOf(disjunction.left)) &&
                atomEq(conclusion, disjunction.right)
            ) {
                return {
                    status: 'valid',
                    rule: 'Disjunctive Syllogism'
                };
            }

            if (
                atomEq(q, negOf(disjunction.right)) &&
                atomEq(conclusion, disjunction.left)
            ) {
                return {
                    status: 'valid',
                    rule: 'Disjunctive Syllogism'
                };
            }
        }
    }

    /* Conjunction Elimination */

    for (const p of premises) {
        const conjunction = topLevelSplit(p, '∧');

        if (!conjunction) {
            continue;
        }

        if (
            atomEq(conclusion, conjunction.left) ||
            atomEq(conclusion, conjunction.right)
        ) {
            return {
                status: 'valid',
                rule: 'Conjunction Elimination'
            };
        }
    }

    /* Conjunction Introduction */

    for (let i = 0; i < premises.length; i++) {
        for (let j = 0; j < premises.length; j++) {
            if (i === j) {
                continue;
            }

            if (
                atomEq(
                    conclusion,
                    premises[i] + ' ∧ ' + premises[j]
                )
            ) {
                return {
                    status: 'valid',
                    rule: 'Conjunction Introduction'
                };
            }
        }
    }

    /* Universal Instantiation */

    for (const p of premises) {
        const match = p.match(
            /^∀\s*([A-Za-z])\s*(.+)$/
        );

        if (!match) {
            continue;
        }

        const variable = match[1];
        const body = stripOuterParens(match[2].trim());

        const escapedBody = body.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
        );

        const variableRegex = new RegExp(
            '\\b' + variable + '\\b',
            'g'
        );

        const patternString =
            '^' +
            escapedBody.replace(
                variableRegex,
                '([A-Za-z0-9_]+)'
            ) +
            '$';

        try {
            const regex = new RegExp(
                patternString,
                'i'
            );

            if (regex.test(conclusion)) {
                return {
                    status: 'valid',
                    rule: 'Universal Instantiation'
                };
            }
        } catch (error) {
            console.error(error);
        }
    }

    return {
        status: 'unrecognized',
        rule: null
    };
}

function renderFOL(note) {
    if (
        note.kind !== 'argument' ||
        !note.premises ||
        !note.premises.length ||
        !note.conclusion
    ) {
        return '';
    }

    const result = checkValidity(
        note.premises,
        note.conclusion
    );

    let badge;

    if (result.status === 'valid') {
        badge = `
            <span class="fol-badge fol-valid">
                Valid — ${escapeHtml(result.rule)}
            </span>
        `;
    } else if (result.status === 'invalid') {
        badge = `
            <span class="fol-badge fol-invalid">
                Invalid — ${escapeHtml(result.rule)}
            </span>
        `;
    } else if (note.manualValid === true) {
        badge = `
            <span class="fol-badge fol-valid-manual">
                Marked valid (manual)
            </span>
        `;
    } else if (note.manualValid === false) {
        badge = `
            <span class="fol-badge fol-invalid-manual">
                Marked invalid (manual)
            </span>
        `;
    } else {
        badge = `
            <span class="fol-badge fol-unknown">
                Not automatically determined
            </span>
        `;
    }

    return `
        <div class="fol-box">
            <h5>Formal argument (FOL)</h5>

            <div class="fol-premises">
                ${note.premises
                    .map(p => `<div>${escapeHtml(p)}</div>`)
                    .join('')}
            </div>

            <div class="fol-conclusion">
                ∴ ${escapeHtml(note.conclusion)}
            </div>

            <div class="fol-result">
                ${badge}
            </div>

            ${
                note.manualNote
                    ? `<div class="fol-manual-note">
                        ${escapeHtml(note.manualNote)}
                       </div>`
                    : ''
            }

            <div class="fol-explanation">
                Checked against classical inference rules
                including modus ponens, modus tollens,
                syllogisms, conjunction rules, and universal
                instantiation. This is a lightweight heuristic,
                not a full theorem prover.
            </div>
        </div>
    `;
}


/* ---------------- tabs ---------------- */

function renderTabs() {
    const counts = {
        vault: allApproved().length,

        graph: allApproved().length,

        community: vault.submissions.filter(
            s => s.status === 'pending'
        ).length,

        approved: allApproved().length
    };

    const labels = {
        vault: 'Vault',
        graph: 'Graph View',
        community: 'Community',
        approved: 'Approved'
    };

    const tabs = document.getElementById('tabs');

    if (!tabs) {
        return;
    }

    tabs.innerHTML = Object.keys(labels)
        .map(key => `
            <div
                class="tab ${view === key ? 'active' : ''}"
                data-tab="${key}"
            >
                ${labels[key]}
                ${key !== 'vault' ? ` ${counts[key]}` : ''}
            </div>
        `)
        .join('');

    tabs.querySelectorAll('.tab').forEach(element => {
        element.addEventListener('click', () => {
            view = element.dataset.tab;
            render();
        });
    });
}


/* ---------------- mobile sidebar ---------------- */

function openMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');

    if (sidebar) sidebar.classList.add('mobile-open');
    if (backdrop) backdrop.classList.add('mobile-open');
}

function closeMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');

    if (sidebar) sidebar.classList.remove('mobile-open');
    if (backdrop) backdrop.classList.remove('mobile-open');
}

function toggleMobileSidebar() {
    const sidebar = document.getElementById('sidebar');

    if (sidebar && sidebar.classList.contains('mobile-open')) {
        closeMobileSidebar();
    } else {
        openMobileSidebar();
    }
}


/* ---------------- sidebar ---------------- */

function renderNode(note) {
    const kids = sortChildren(childrenOf(note.id));
    const hasKids = kids.length > 0;
    const isOpen = openFolders.has(note.id);

    let icon = '';

    if (note.kind === 'topic') {
        icon = '<span class="node-icon node-icon-topic">▰</span>';
    } else if (note.kind === 'view') {
        icon = '<span class="node-icon node-icon-view">◐</span>';
    } else if (note.kind === 'summary') {
        icon = '<span class="node-icon node-icon-summary">▤</span>';
    }

    const dot = note.kind === 'argument'
        ? `<span class="dot ${note.relation === 'refutation' ? 'con' : 'pro'}"></span>`
        : '';

    const row = `
        <div
            class="tree-row ${isOpen ? 'open' : ''} ${activeNoteId === note.id ? 'active' : ''}"
            data-note="${note.id}"
        >
            <span
                class="chev"
                data-toggle="${note.id}"
                style="visibility:${hasKids ? 'visible' : 'hidden'}"
            >▶</span>

            ${icon || dot}

            <span>${escapeHtml(note.title)}</span>
        </div>
    `;

    const childrenHtml = hasKids
        ? `
            <div
                class="tree-children"
                style="display:${isOpen ? 'block' : 'none'}"
            >
                ${kids.map(k => renderNode(k)).join('')}
            </div>
        `
        : '';

    return `<div>${row}${childrenHtml}</div>`;
}

function renderSearchResults() {
    const q = sidebarQuery.trim().toLowerCase();

    if (!q) {
        return '';
    }

    const matches = allApproved()
        .filter(n => n.title.toLowerCase().includes(q))
        .slice(0, 30);

    if (!matches.length) {
        return `
            <div class="sidebar-search-results">
                <div class="sidebar-search-empty">
                    No notes match “${escapeHtml(sidebarQuery.trim())}”.
                </div>
            </div>
        `;
    }

    return `
        <div class="sidebar-search-results">
            ${matches
                .map(note => {
                    const crumb = ancestorPath(note);

                    return `
                        <div
                            class="tree-row ${activeNoteId === note.id ? 'active' : ''}"
                            data-note="${note.id}"
                        >
                            <span class="chev" style="visibility:hidden">▶</span>
                            <span>${escapeHtml(note.title)}</span>
                            ${crumb ? `<span class="sidebar-search-crumb">${escapeHtml(crumb)}</span>` : ''}
                        </div>
                    `;
                })
                .join('')}
        </div>
    `;
}

function renderSidebar() {
    const sidebar = document.getElementById('sidebar');

    if (!sidebar || !vault) {
        return;
    }

    const roots = sortChildren(
        vault.notes.filter(
            n => n.status === 'approved' && !n.parentId
        )
    );

    const searching = sidebarQuery.trim().length > 0;

    sidebar.innerHTML = `
        <div class="sidebar-search">
            <input
                type="search"
                id="sidebarSearchInput"
                placeholder="Search notes…"
                value="${escapeHtml(sidebarQuery)}"
            >
        </div>

        ${
            searching
                ? renderSearchResults()
                : `
                    <h4>Vault · ${allApproved().length} notes</h4>
                    ${roots.map(renderNode).join('')}
                `
        }
    `;

    const searchInput = document.getElementById('sidebarSearchInput');

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            sidebarQuery = searchInput.value;
            renderSidebar();
        });

        // Keep focus + caret position when re-rendering while typing.
        if (searching) {
            searchInput.focus();
            const pos = searchInput.value.length;
            searchInput.setSelectionRange(pos, pos);
        }
    }

    sidebar.querySelectorAll('.chev').forEach(element => {
        element.addEventListener('click', event => {
            event.stopPropagation();

            const id = element.dataset.toggle;

            if (openFolders.has(id)) {
                openFolders.delete(id);
            } else {
                openFolders.add(id);
            }

            renderSidebar();
        });
    });

    sidebar.querySelectorAll('.tree-row[data-note]').forEach(element => {
        element.addEventListener('click', () => {
            const id = element.dataset.note;
            activeNoteId = id;
            view = 'vault';

            const target = noteById(id);
            if (target) {
                expandToNote(target);
            }

            closeMobileSidebar();
            render();
        });
    });
}


/* ---------------- reader view ---------------- */

function renderReader() {
    const main = document.getElementById('main');

    if (!main) {
        return;
    }

    if (!activeNoteId) {
        const first =
            allApproved().find(n => !n.parentId) ||
            allApproved()[0];

        if (first) {
            activeNoteId = first.id;
            expandToNote(first);
        }
    }

    const note = noteById(activeNoteId);

    if (!note) {
        main.innerHTML = `
            <div class="empty-state">
                <div class="mark-big">Debatepedia</div>
                <h2>Nothing here yet</h2>
                <p>
                    Pick a note from the vault, or submit
                    the first one from the Community tab.
                </p>
            </div>
        `;

        return;
    }

    const backlinks = findBacklinks(note);
    const crumbChain = ancestorChain(note);
    const parentNote = note.parentId ? noteById(note.parentId) : null;

    main.innerHTML = `
        <div class="reader">

            <div class="reader-actions">
                ${
                    parentNote
                        ? `
                            <button
                                class="btn-edit"
                                id="goToParentBtn"
                                data-nav="${escapeHtml(parentNote.id)}"
                            >
                                ↑ Go to parent
                            </button>
                        `
                        : ''
                }

                <button
                    class="btn-edit"
                    id="suggestEditBtn"
                >
                    Suggest an edit
                </button>

                ${
                    currentUser && currentUser.isAdmin
                        ? `
                            <button
                                class="btn-edit btn-delete"
                                id="deleteNoteBtn"
                            >
                                Delete
                            </button>
                        `
                        : ''
                }
            </div>

            <nav class="breadcrumb-trail" aria-label="Note location">
                ${crumbChain
                    .map(
                        ancestor => `
                            <span
                                class="breadcrumb-item"
                                data-nav="${escapeHtml(ancestor.id)}"
                                title="${escapeHtml(ancestor.title)}"
                            >${escapeHtml(ancestor.title)}</span>
                            <span class="breadcrumb-sep">›</span>
                        `
                    )
                    .join('')}
                <span class="breadcrumb-item breadcrumb-current">
                    ${escapeHtml(note.title)}
                </span>
            </nav>

            <div class="eyebrow">
                ${chipHTML(
                    note.kind,
                    note.relation
                )}
            </div>

            <h1>${escapeHtml(note.title)}</h1>

            <div class="meta">
                by ${escapeHtml(note.author || 'Unknown')}
                ·
                ${new Date(note.createdAt).toLocaleDateString()}
                ${
                    note.editedAt
                        ? ` · edited ${new Date(
                            note.editedAt
                        ).toLocaleDateString()}`
                        : ''
                }
            </div>

            <div class="content">
                ${renderContentHTML(note.content)}
            </div>

            ${renderFOL(note)}

            ${
                (note.tags || []).length
                    ? `
                        <div class="tagrow">
                            ${note.tags
                                .map(
                                    tag =>
                                        `<span class="tag">
                                            #${escapeHtml(tag)}
                                         </span>`
                                )
                                .join('')}
                        </div>
                    `
                    : ''
            }

            <div class="backlinks">
                <h5>
                    Linked from (${backlinks.length})
                </h5>

                ${
                    backlinks.length
                        ? backlinks
                            .map(
                                backlink => `
                                    <div
                                        class="backlink"
                                        data-nav="${escapeHtml(
                                            backlink.id
                                        )}"
                                    >
                                        ${escapeHtml(
                                            backlink.title
                                        )}
                                    </div>
                                `
                            )
                            .join('')
                        : 'No notes link here yet.'
                }
            </div>

        </div>
    `;

    document
        .querySelectorAll('[data-nav]')
        .forEach(element => {
            element.addEventListener('click', () => {
                const id = element.dataset.nav;

                if (!id) {
                    return;
                }

                activeNoteId = id;
                view = 'vault';

                const target = noteById(id);

                if (target) {
                    expandToNote(target);
                }

                closeMobileSidebar();
                render();
            });
        });

    const editButton =
        document.getElementById('suggestEditBtn');

    if (editButton) {
        editButton.addEventListener('click', () => {
            if (!currentUser) {
                showAuth('login');
                return;
            }

            editTargetId = note.id;
            submitMode = 'edit';
            view = 'community';

            render();
        });
    }

    const deleteButton =
        document.getElementById('deleteNoteBtn');

    if (deleteButton) {
        deleteButton.addEventListener('click', async () => {
            const confirmed = confirm(
                `Delete "${note.title}"? This cannot be undone.`
            );

            if (!confirmed) {
                return;
            }

            deleteButton.disabled = true;

            try {
                await apiJson(
                    `/api/notes/${note.id}`,
                    { method: 'DELETE' }
                );

                const parentId = note.parentId;

                activeNoteId = parentId && noteById(parentId)
                    ? parentId
                    : null;

                await loadVault();
                render();
            } catch (error) {
                console.error(error);

                alert(
                    error.message ||
                    'Unable to delete this note.'
                );

                deleteButton.disabled = false;
            }
        });
    }
}


/* ---------------- graph view ---------------- */

function buildGraphData() {
    const notes = allApproved();

    const nodes = notes.map(note => ({
        id: note.id,
        title: note.title,
        kind: note.kind,
        relation: note.relation,
        x: Math.random() * 600 - 300,
        y: Math.random() * 400 - 200,
        vx: 0,
        vy: 0
    }));

    const idSet = new Set(
        nodes.map(node => node.id)
    );

    const edges = [];

    notes.forEach(note => {
        if (
            note.parentId &&
            idSet.has(note.parentId)
        ) {
            edges.push({
                a: note.id,
                b: note.parentId,
                type: 'hierarchy'
            });
        }

        const matches = [
            ...(note.content || '').matchAll(
                /\[\[([^\]]+)\]\]/g
            )
        ];

        matches.forEach(match => {
            const target = noteByTitle(match[1]);

            if (
                target &&
                target.id !== note.id &&
                idSet.has(target.id)
            ) {
                const exists = edges.find(
                    edge =>
                        edge.type === 'link' &&
                        (
                            (
                                edge.a === note.id &&
                                edge.b === target.id
                            ) ||
                            (
                                edge.a === target.id &&
                                edge.b === note.id
                            )
                        )
                );

                if (!exists) {
                    edges.push({
                        a: note.id,
                        b: target.id,
                        type: 'link'
                    });
                }
            }
        });
    });

    return {
        nodes,
        edges
    };
}

function renderGraph() {
    const main = document.getElementById('main');

    main.innerHTML = `
        <div class="graph-view">

            <div class="graph-header">

                <div class="graph-legend">
                    <span>
                        <i class="legend-dot topic"></i>
                        Topic
                    </span>

                    <span>
                        <i class="legend-dot view"></i>
                        View
                    </span>

                    <span>
                        <i class="legend-dot summary"></i>
                        Summary
                    </span>

                    <span>
                        <i class="legend-dot supporting"></i>
                        Supporting
                    </span>

                    <span>
                        <i class="legend-dot refutation"></i>
                        Refutation
                    </span>
                </div>

            </div>

            <div class="graph-container">
                <canvas id="graphCanvas"></canvas>
                <div
                    id="gTooltip"
                    class="graph-tooltip"
                    style="display:none;"
                ></div>
            </div>

        </div>
    `;

    const canvas =
        document.getElementById('graphCanvas');

    if (!canvas) {
        return;
    }

    const ctx = canvas.getContext('2d');

    if (!ctx) {
        return;
    }

    const container =
        canvas.parentElement;

    function resizeCanvas() {
        const rect =
            container.getBoundingClientRect();

        const ratio =
            window.devicePixelRatio || 1;

        canvas.width =
            rect.width * ratio;

        canvas.height =
            rect.height * ratio;

        canvas.style.width =
            rect.width + 'px';

        canvas.style.height =
            rect.height + 'px';

        ctx.setTransform(
            ratio,
            0,
            0,
            ratio,
            0,
            0
        );
    }

    resizeCanvas();

    window.addEventListener(
        'resize',
        resizeCanvas
    );

    const data = buildGraphData();

    graphState = {
        data,
        raf: null
    };

    let dragging = null;
    let panX = 0;
    let panY = 0;
    let isPanning = false;
    let panStart = null;

    function tick() {
        const {
            nodes,
            edges
        } = data;

        for (
            let i = 0;
            i < nodes.length;
            i++
        ) {
            for (
                let j = i + 1;
                j < nodes.length;
                j++
            ) {
                const a = nodes[i];
                const b = nodes[j];

                let dx = a.x - b.x;
                let dy = a.y - b.y;

                let distance =
                    Math.sqrt(
                        dx * dx +
                        dy * dy
                    ) || 0.01;

                const force =
                    2200 /
                    (distance * distance);

                dx /= distance;
                dy /= distance;

                a.vx += dx * force;
                a.vy += dy * force;

                b.vx -= dx * force;
                b.vy -= dy * force;
            }
        }

        edges.forEach(edge => {
            const a = nodes.find(
                node => node.id === edge.a
            );

            const b = nodes.find(
                node => node.id === edge.b
            );

            if (!a || !b) {
                return;
            }

            let dx = b.x - a.x;
            let dy = b.y - a.y;

            let distance =
                Math.sqrt(
                    dx * dx +
                    dy * dy
                ) || 0.01;

            const rest =
                edge.type === 'hierarchy'
                    ? 110
                    : 150;

            const force =
                (distance - rest) * 0.02;

            dx /= distance;
            dy /= distance;

            a.vx += dx * force;
            a.vy += dy * force;

            b.vx -= dx * force;
            b.vy -= dy * force;
        });

        nodes.forEach(node => {
            if (node === dragging) {
                return;
            }

            node.vx += -node.x * 0.002;
            node.vy += -node.y * 0.002;

            node.vx *= 0.85;
            node.vy *= 0.85;

            node.x += node.vx;
            node.y += node.vy;
        });
    }

    function draw() {
        const width =
            canvas.clientWidth;

        const height =
            canvas.clientHeight;

        ctx.clearRect(
            0,
            0,
            width,
            height
        );

        ctx.save();

        ctx.translate(
            width / 2 + panX,
            height / 2 + panY
        );

        data.edges.forEach(edge => {
            const a = data.nodes.find(
                node => node.id === edge.a
            );

            const b = data.nodes.find(
                node => node.id === edge.b
            );

            if (!a || !b) {
                return;
            }

            if (edge.type === 'hierarchy') {
                ctx.strokeStyle =
                    'rgba(120,124,140,0.22)';

                ctx.setLineDash([3, 4]);
            } else {
                ctx.strokeStyle =
                    'rgba(215,181,109,0.35)';

                ctx.setLineDash([]);
            }

            ctx.lineWidth = 1;

            ctx.beginPath();

            ctx.moveTo(
                a.x,
                a.y
            );

            ctx.lineTo(
                b.x,
                b.y
            );

            ctx.stroke();
        });

        ctx.setLineDash([]);

        data.nodes.forEach(node => {
            const radius =
                node.kind === 'topic'
                    ? 9
                    : node.kind === 'view'
                        ? 7.5
                        : node.kind === 'summary'
                            ? 6.5
                            : 6;

            ctx.beginPath();

            ctx.fillStyle =
                kindColor(node);

            ctx.shadowColor =
                kindColor(node);

            ctx.shadowBlur =
                node.id === activeNoteId
                    ? 16
                    : 6;

            ctx.arc(
                node.x,
                node.y,
                radius,
                0,
                Math.PI * 2
            );

            ctx.fill();

            ctx.shadowBlur = 0;

            ctx.fillStyle = '#e9e7e0';

            ctx.font =
                node.kind === 'topic'
                    ? '600 12px sans-serif'
                    : '500 11px sans-serif';

            ctx.textAlign = 'center';

            const title =
                node.title.length > 26
                    ? node.title.slice(0, 24) + '…'
                    : node.title;

            ctx.fillText(
                title,
                node.x,
                node.y + radius + 14
            );
        });

        ctx.restore();
    }

    function loop() {
        tick();
        draw();

        if (graphState) {
            graphState.raf =
                requestAnimationFrame(loop);
        }
    }

    loop();

    function toWorld(mx, my) {
        return {
            x:
                mx -
                canvas.clientWidth / 2 -
                panX,

            y:
                my -
                canvas.clientHeight / 2 -
                panY
        };
    }

    function nodeAt(mx, my) {
        const world =
            toWorld(mx, my);

        return data.nodes.find(
            node =>
                Math.hypot(
                    node.x - world.x,
                    node.y - world.y
                ) < 14
        );
    }

    const tooltip =
        document.getElementById('gTooltip');

    canvas.addEventListener(
        'mousedown',
        event => {
            const rect =
                canvas.getBoundingClientRect();

            const mx =
                event.clientX - rect.left;

            const my =
                event.clientY - rect.top;

            const node =
                nodeAt(mx, my);

            if (node) {
                dragging = node;
            } else {
                isPanning = true;

                panStart = {
                    x: event.clientX - panX,
                    y: event.clientY - panY
                };
            }
        }
    );

    window.addEventListener(
        'mousemove',
        event => {
            const rect =
                canvas.getBoundingClientRect();

            const mx =
                event.clientX - rect.left;

            const my =
                event.clientY - rect.top;

            if (dragging) {
                const world =
                    toWorld(mx, my);

                dragging.x = world.x;
                dragging.y = world.y;

                dragging.vx = 0;
                dragging.vy = 0;

                return;
            }

            if (isPanning) {
                panX =
                    event.clientX -
                    panStart.x;

                panY =
                    event.clientY -
                    panStart.y;

                return;
            }

            const node =
                nodeAt(mx, my);

            if (node) {
                const full =
                    noteById(node.id);

                tooltip.style.display =
                    'block';

                tooltip.style.left =
                    mx + 16 + 'px';

                tooltip.style.top =
                    my + 10 + 'px';

                tooltip.innerHTML = `
                    <b>
                        ${escapeHtml(full.title)}
                    </b>
                    <br>
                    ${escapeHtml(
                        ancestorPath(full) ||
                        'Root'
                    )}
                `;

                canvas.style.cursor =
                    'pointer';
            } else {
                tooltip.style.display =
                    'none';

                canvas.style.cursor =
                    'grab';
            }
        }
    );

    window.addEventListener(
        'mouseup',
        () => {
            dragging = null;
            isPanning = false;
        }
    );

    canvas.addEventListener(
        'click',
        event => {
            const rect =
                canvas.getBoundingClientRect();

            const mx =
                event.clientX - rect.left;

            const my =
                event.clientY - rect.top;

            const node =
                nodeAt(mx, my);

            if (!node) {
                return;
            }

            activeNoteId = node.id;
            view = 'vault';

            const full =
                noteById(node.id);

            if (full) {
                expandToNote(full);
            }

            render();
        }
    );
}


/* ---------------- approved grid ---------------- */

function renderApprovedGrid() {
    const main =
        document.getElementById('main');

    const notes =
        allApproved()
            .slice()
            .sort(
                (a, b) =>
                    new Date(b.createdAt) -
                    new Date(a.createdAt)
            );

    main.innerHTML = `
        <div class="grid-view">

            <div class="grid-header">
                <h1>Approved library</h1>
            </div>

            <p>
                Every note here has passed community
                review and is part of the permanent vault.
            </p>

            <div class="card-grid">
                ${
                    notes.length
                        ? notes.map(note => `
                            <div
                                class="note-card"
                                data-note-card="${escapeHtml(
                                    note.id
                                )}"
                            >
                                <div>
                                    ${chipHTML(
                                        note.kind,
                                        note.relation
                                    )}
                                </div>

                                <h3>
                                    ${escapeHtml(
                                        note.title
                                    )}
                                </h3>

                                <p>
                                    ${escapeHtml(
                                        (note.content || '')
                                            .replace(
                                                /\[\[|\]\]/g,
                                                ''
                                            )
                                            .slice(0, 110)
                                    )}${(
                                        note.content || ''
                                    ).length > 110
                                        ? '…'
                                        : ''}
                                </p>

                                <div class="card-meta">
                                    ${escapeHtml(
                                        ancestorPath(note) ||
                                        'Root'
                                    )}
                                </div>

                                <div class="card-author">
                                    ${escapeHtml(
                                        note.author ||
                                        'Unknown'
                                    )}
                                </div>
                            </div>
                        `).join('')
                        : `
                            <div class="empty-state">
                                No approved notes yet.
                            </div>
                        `
                }
            </div>
        </div>
    `;

    main
        .querySelectorAll('[data-note-card]')
        .forEach(element => {
            element.addEventListener(
                'click',
                () => {
                    const id =
                        element.dataset.noteCard;

                    activeNoteId = id;
                    view = 'vault';

                    const note =
                        noteById(id);

                    if (note) {
                        expandToNote(note);
                    }

                    render();
                }
            );
        });
}


/* ---------------- community ---------------- */

function noteOptions(selectedId) {
    return allApproved()
        .slice()
        .sort(
            (a, b) =>
                fullPath(a).localeCompare(
                    fullPath(b)
                )
        )
        .map(
            note => `
                <option
                    value="${escapeHtml(note.id)}"
                    ${
                        selectedId === note.id
                            ? 'selected'
                            : ''
                    }
                >
                    ${escapeHtml(
                        fullPath(note)
                    )}
                </option>
            `
        )
        .join('');
}

function renderCommunity() {
    const main =
        document.getElementById('main');

    if (!currentUser) {
        main.innerHTML = `
            <div class="grid-view">

                <div class="grid-header">
                    <h1>Community</h1>
                </div>

                <p>
                    Sign in to submit new notes or
                    suggest edits. Contributions are
                    reviewed by administrators before
                    entering the permanent vault.
                </p>

                <div class="submit-box">
                    <button
                        class="btn btn-primary"
                        id="communityLogin"
                    >
                        Log in to contribute
                    </button>

                    <button
                        class="account-btn"
                        id="communityRegister"
                    >
                        Create account
                    </button>
                </div>

            </div>
        `;

        document
            .getElementById('communityLogin')
            ?.addEventListener(
                'click',
                () => showAuth('login')
            );

        document
            .getElementById('communityRegister')
            ?.addEventListener(
                'click',
                () => showAuth('register')
            );

        return;
    }

    const pending =
        vault.submissions
            .filter(
                submission =>
                    submission.status === 'pending'
            )
            .sort(
                (a, b) =>
                    new Date(b.createdAt) -
                    new Date(a.createdAt)
            );

    const mode = submitMode;

    const editTarget =
        editTargetId
            ? noteById(editTargetId)
            : null;

    main.innerHTML = `
        <div class="grid-view">

            <div class="grid-header">
                <h1>Community</h1>
            </div>

            <p>
                Submit a new note or suggest an edit.
                Contributions remain pending until an
                administrator reviews them.
            </p>

            <div class="submit-box">

                <div class="mode-toggle">
                    <button
                        class="mode-btn ${
                            mode === 'new'
                                ? 'active'
                                : ''
                        }"
                        id="mode-new"
                    >
                        New note
                    </button>

                    <button
                        class="mode-btn ${
                            mode === 'edit'
                                ? 'active'
                                : ''
                        }"
                        id="mode-edit"
                    >
                        Suggest an edit
                    </button>
                </div>

                ${
                    mode === 'new'
                        ? `
                            <div class="form-row">
                                <select id="f-kind">
                                    <option value="topic">
                                        Topic
                                    </option>
                                    <option value="view">
                                        View
                                    </option>
                                    <option value="summary">
                                        Summary
                                    </option>
                                    <option value="argument">
                                        Argument
                                    </option>
                                </select>

                                <select id="f-relation">
                                    <option value="support">
                                        Supports parent
                                    </option>
                                    <option value="refutation">
                                        Refutes / challenges parent
                                    </option>
                                </select>
                            </div>

                            <div class="form-row full">
                                <input
                                    id="f-title"
                                    placeholder="Title"
                                >
                            </div>

                            <div class="form-row full">
                                <select id="f-parent">
                                    <option value="">
                                        No parent (root topic)
                                    </option>

                                    ${noteOptions(null)}
                                </select>
                            </div>

                            <div class="form-row full">
                                <input
                                    id="f-tags"
                                    placeholder="Tags, separated by commas"
                                >
                            </div>

                            <div class="form-row full">
                                <textarea
                                    id="f-content"
                                    placeholder="Write the note using Markdown..."
                                ></textarea>
                            </div>

                            <div id="folSection"></div>
                        `
                        : `
                            <div class="form-row full">
                                <select id="f-edit-target">
                                    <option value="">
                                        Select a note to edit
                                    </option>

                                    ${noteOptions(
                                        editTarget
                                            ? editTarget.id
                                            : null
                                    )}
                                </select>
                            </div>

                            ${
                                editTarget
                                    ? `
                                        <div class="form-row full">
                                            <input
                                                id="f-title"
                                                value="${escapeHtml(
                                                    editTarget.title
                                                )}"
                                                placeholder="Title"
                                            >
                                        </div>

                                        <div class="form-row full">
                                            <input
                                                id="f-tags"
                                                value="${escapeHtml(
                                                    (
                                                        editTarget.tags ||
                                                        []
                                                    ).join(', ')
                                                )}"
                                                placeholder="Tags"
                                            >
                                        </div>

                                        <div class="form-row full">
                                            <textarea
                                                id="f-content"
                                                placeholder="Write the note using Markdown..."
                                            >${escapeHtml(
                                                editTarget.content
                                            )}</textarea>
                                        </div>

                                        <div id="folSection"></div>
                                    `
                                    : `
                                        <div class="hint">
                                            Choose a note above to load it
                                            for editing.
                                        </div>
                                    `
                            }
                        `
                }

                <button
                    class="btn btn-primary"
                    id="f-submit"
                    style="margin-top:6px;"
                >
                    ${
                        mode === 'new'
                            ? 'Submit for review'
                            : 'Submit edit for review'
                    }
                </button>

            </div>

            <div class="moderation-section">
                <h2>
                    ${
                        currentUser.isAdmin
                            ? `Admin moderation queue (${pending.length})`
                            : `Your submissions (${pending.length})`
                    }
                </h2>

                <div id="pendingList"></div>
            </div>

        </div>
    `;

    function paintFOL(
        premises,
        conclusion,
        manualValid,
        manualNote
    ) {
        const element =
            document.getElementById(
                'folSection'
            );

        if (!element) {
            return;
        }

        element.innerHTML = `
            <div class="form-row full">

                <textarea
                    id="f-premises"
                    placeholder="Premises, one per line, e.g. Consumer(x) → Pays(x, VAT)"
                >${escapeHtml(
                    premises || ''
                )}</textarea>

                <div class="hint">
                    Optional formal premises for
                    FOL validity checking.
                </div>

            </div>

            <div class="form-row">

                <input
                    id="f-conclusion"
                    placeholder="Conclusion"
                    value="${escapeHtml(
                        conclusion || ''
                    )}"
                    style="flex:2"
                >

                <select id="f-manual">
                    <option
                        value="auto"
                        ${
                            manualValid == null
                                ? 'selected'
                                : ''
                        }
                    >
                        Let checker decide
                    </option>

                    <option
                        value="valid"
                        ${
                            manualValid === true
                                ? 'selected'
                                : ''
                        }
                    >
                        Assert valid
                    </option>

                    <option
                        value="invalid"
                        ${
                            manualValid === false
                                ? 'selected'
                                : ''
                        }
                    >
                        Assert invalid
                    </option>
                </select>

            </div>

            <div class="form-row full">
                <input
                    id="f-manual-note"
                    placeholder="Rationale, if asserting manually (optional)"
                    value="${escapeHtml(
                        manualNote || ''
                    )}"
                >
            </div>
        `;
    }

    if (mode === 'new') {
        const kindSelect =
            document.getElementById(
                'f-kind'
            );

        const relationSelect =
            document.getElementById(
                'f-relation'
            );

        const syncFOL =
            () => {
                const isArgument =
                    kindSelect.value ===
                    'argument';

                relationSelect.style.display =
                    isArgument
                        ? 'block'
                        : 'none';

                if (isArgument) {
                    paintFOL(
                        '',
                        '',
                        null,
                        ''
                    );
                } else {
                    const fol =
                        document.getElementById(
                            'folSection'
                        );

                    if (fol) {
                        fol.innerHTML = '';
                    }
                }
            };

        kindSelect.addEventListener(
            'change',
            syncFOL
        );

        syncFOL();
    } else if (
        editTarget &&
        editTarget.kind === 'argument'
    ) {
        paintFOL(
            (editTarget.premises || [])
                .join('\n'),
            editTarget.conclusion || '',
            editTarget.manualValid ?? null,
            editTarget.manualNote || ''
        );
    }

    document
        .getElementById('mode-new')
        ?.addEventListener(
            'click',
            () => {
                submitMode = 'new';
                render();
            }
        );

    document
        .getElementById('mode-edit')
        ?.addEventListener(
            'click',
            () => {
                submitMode = 'edit';

                if (!editTargetId) {
                    editTargetId =
                        allApproved()[0]?.id ||
                        null;
                }

                render();
            }
        );

    document
        .getElementById('f-edit-target')
        ?.addEventListener(
            'change',
            event => {
                editTargetId =
                    event.target.value ||
                    null;

                render();
            }
        );

    document
        .getElementById('f-submit')
        ?.addEventListener(
            'click',
            async () => {
                try {
                    if (mode === 'new') {
                        await submitNew();
                    } else {
                        await submitEdit();
                    }
                } catch (error) {
                    console.error(error);
                    alert(
                        error.message ||
                        'Something went wrong.'
                    );
                }
            }
        );

    renderPendingList(pending);
}


/* ---------------- submission creation ---------------- */

async function submitNew() {
    const title =
        document
            .getElementById('f-title')
            .value
            .trim();

    const content =
        document
            .getElementById('f-content')
            .value
            .trim();

    const kind =
        document
            .getElementById('f-kind')
            .value;

    const parentId =
        document
            .getElementById('f-parent')
            .value ||
        null;

    const relationElement =
        document.getElementById(
            'f-relation'
        );

    const tags =
        document
            .getElementById('f-tags')
            .value
            .trim();

    if (!title || !content) {
        alert(
            'Give the note a title and some content first.'
        );

        return;
    }

    const data = {
        type: 'new',
        kind,
        parentId,
        relation:
            kind === 'argument' &&
            relationElement
                ? relationElement.value
                : null,
        title,
        content,
        tags
    };

    if (
        kind === 'argument' &&
        document.getElementById(
            'f-premises'
        )
    ) {
        data.premises =
            document
                .getElementById(
                    'f-premises'
                )
                .value;

        data.conclusion =
            document
                .getElementById(
                    'f-conclusion'
                )
                .value
                .trim();

        data.manualValid =
            document
                .getElementById(
                    'f-manual'
                )
                .value;

        data.manualNote =
            document
                .getElementById(
                    'f-manual-note'
                )
                .value
                .trim();
    }

    await apiJson(
        '/api/submissions',
        {
            method: 'POST',
            body: JSON.stringify(data)
        }
    );

    alert(
        'Submitted for admin review.'
    );

    await loadVault();

    render();
}


/* ---------------- edit submission ---------------- */

async function submitEdit() {
    if (!editTargetId) {
        alert(
            'Select a note to edit first.'
        );

        return;
    }

    const target =
        noteById(editTargetId);

    const title =
        document
            .getElementById('f-title')
            .value
            .trim();

    const content =
        document
            .getElementById('f-content')
            .value
            .trim();

    const tags =
        document
            .getElementById('f-tags')
            .value
            .trim();

    if (
        !target ||
        !title ||
        !content
    ) {
        alert(
            'Title and content are required.'
        );

        return;
    }

    const data = {
        type: 'edit',
        targetId: editTargetId,
        title,
        content,
        tags
    };

    if (
        target.kind === 'argument' &&
        document.getElementById(
            'f-premises'
        )
    ) {
        data.premises =
            document
                .getElementById(
                    'f-premises'
                )
                .value;

        data.conclusion =
            document
                .getElementById(
                    'f-conclusion'
                )
                .value
                .trim();

        data.manualValid =
            document
                .getElementById(
                    'f-manual'
                )
                .value;

        data.manualNote =
            document
                .getElementById(
                    'f-manual-note'
                )
                .value
                .trim();
    }

    await apiJson(
        '/api/submissions',
        {
            method: 'POST',
            body: JSON.stringify(data)
        }
    );

    alert(
        'Edit submitted for admin review.'
    );

    editTargetId = null;

    await loadVault();

    render();
}


/* ---------------- pending submissions ---------------- */

function renderPendingList(pending) {
    const list =
        document.getElementById(
            'pendingList'
        );

    if (!list) {
        return;
    }

    if (!pending.length) {
        list.innerHTML =
            '<p>Nothing waiting right now.</p>';

        return;
    }

    list.innerHTML =
        pending
            .map(submission => {
                if (
                    submission.type ===
                    'edit'
                ) {
                    const target =
                        noteById(
                            submission.targetId
                        );

                    return `
                        <div class="pending-card">

                            <div class="top">

                                <div>
                                    <span
                                        class="badge-pending"
                                    >
                                        Proposed edit
                                    </span>

                                    <h4>
                                        ${escapeHtml(
                                            target
                                                ? target.title
                                                : 'Unknown note'
                                        )}
                                    </h4>

                                    <div
                                        style="
                                            font-family:var(--font-mono);
                                            font-size:10.5px;
                                            color:var(--text-faint);
                                        "
                                    >
                                        by ${escapeHtml(
                                            submission.author ||
                                            'Unknown'
                                        )}
                                    </div>
                                </div>

                                <span class="badge-pending">
                                    Pending
                                </span>

                            </div>

                            <div
                                class="diff-block diff-current"
                            >
                                <span class="diff-label">
                                    Current
                                </span>

                                ${escapeHtml(
                                    (
                                        target
                                            ? target.content
                                            : ''
                                    ).slice(0, 180)
                                )}
                            </div>

                            <div
                                class="diff-block diff-proposed"
                            >
                                <span class="diff-label">
                                    Proposed
                                </span>

                                ${escapeHtml(
                                    (
                                        submission.proposedContent ||
                                        submission.content ||
                                        ''
                                    ).slice(0, 180)
                                )}
                            </div>

                            ${
                                currentUser.isAdmin
                                    ? `
                                        <div class="pending-actions">

                                            <button
                                                class="btn btn-primary"
                                                data-approve="${escapeHtml(
                                                    submission.id
                                                )}"
                                            >
                                                Approve edit
                                            </button>

                                            <button
                                                class="btn"
                                                data-reject="${escapeHtml(
                                                    submission.id
                                                )}"
                                            >
                                                Decline
                                            </button>

                                        </div>
                                    `
                                    : ''
                            }

                        </div>
                    `;
                }

                return `
                    <div class="pending-card">

                        <div class="top">

                            <div>
                                ${chipHTML(
                                    submission.kind,
                                    submission.relation
                                )}

                                <h4>
                                    ${escapeHtml(
                                        submission.title
                                    )}
                                </h4>

                                <div
                                    style="
                                        font-family:var(--font-mono);
                                        font-size:10.5px;
                                        color:var(--text-faint);
                                    "
                                >
                                    by ${escapeHtml(
                                        submission.author ||
                                        'Unknown'
                                    )}
                                </div>
                            </div>

                            <span class="badge-pending">
                                ${escapeHtml(
                                    submission.status
                                )}
                            </span>

                        </div>

                        <p>
                            ${escapeHtml(
                                (
                                    submission.content ||
                                    ''
                                ).slice(0, 220)
                            )}
                        </p>

                        ${
                            currentUser.isAdmin
                                ? `
                                    <div class="pending-actions">

                                        <button
                                            class="btn btn-primary"
                                            data-approve="${escapeHtml(
                                                submission.id
                                            )}"
                                        >
                                            Approve
                                        </button>

                                        <button
                                            class="btn"
                                            data-reject="${escapeHtml(
                                                submission.id
                                            )}"
                                        >
                                            Decline
                                        </button>

                                    </div>
                                `
                                : ''
                        }

                    </div>
                `;
            })
            .join('');

    if (currentUser.isAdmin) {
        list
            .querySelectorAll(
                '[data-approve]'
            )
            .forEach(element => {
                element.addEventListener(
                    'click',
                    async () => {
                        try {
                            await apiJson(
                                `/api/submissions/${element.dataset.approve}/approve`,
                                {
                                    method: 'POST'
                                }
                            );

                            await loadVault();

                            render();
                        } catch (error) {
                            console.error(error);

                            alert(
                                error.message ||
                                'Unable to approve submission.'
                            );
                        }
                    }
                );
            });

        list
            .querySelectorAll(
                '[data-reject]'
            )
            .forEach(element => {
                element.addEventListener(
                    'click',
                    async () => {
                        const reason =
                            prompt(
                                'Optional reason for rejection:'
                            ) || '';

                        try {
                            await apiJson(
                                `/api/submissions/${element.dataset.reject}/reject`,
                                {
                                    method: 'POST',
                                    body: JSON.stringify({
                                        note: reason
                                    })
                                }
                            );

                            await loadVault();

                            render();
                        } catch (error) {
                            console.error(error);

                            alert(
                                error.message ||
                                'Unable to reject submission.'
                            );
                        }
                    }
                );
            });
    }
}


/* ---------------- root render ---------------- */

function stopGraphLoop() {
    if (
        graphState &&
        graphState.raf
    ) {
        cancelAnimationFrame(
            graphState.raf
        );

        graphState = null;
    }
}

function render() {
    if (!vault) {
        return;
    }

    stopGraphLoop();

    renderTabs();
    renderSidebar();

    if (view === 'vault') {
        renderReader();
    } else if (view === 'graph') {
        renderGraph();
    } else if (view === 'community') {
        renderCommunity();
    } else if (view === 'approved') {
        renderApprovedGrid();
    }
}


/* ---------------- initialise ---------------- */

(async function init() {
    const main =
        document.getElementById('main');

    const menuToggle = document.getElementById('menuToggle');
    const backdrop = document.getElementById('sidebarBackdrop');

    if (menuToggle) {
        menuToggle.addEventListener('click', toggleMobileSidebar);
    }

    if (backdrop) {
        backdrop.addEventListener('click', closeMobileSidebar);
    }

    window.addEventListener('resize', () => {
        if (window.innerWidth > 760) {
            closeMobileSidebar();
        }
    });

    if (main) {
        main.innerHTML =
            'Opening vault…';
    }

    try {
        await loadCurrentUser();
        await loadVault();

        render();
    } catch (error) {
        console.error(
            'Failed to initialise Debatepedia:',
            error
        );

        if (main) {
            main.innerHTML = `
                <div class="empty-state">
                    <h2>
                        Unable to load Debatepedia
                    </h2>

                    <p>
                        The application could not
                        connect to the backend.
                    </p>

                    <p class="error-detail">
                        ${escapeHtml(
                            error.message ||
                            'Unknown error'
                        )}
                    </p>
                </div>
            `;
        }
    }
})();
