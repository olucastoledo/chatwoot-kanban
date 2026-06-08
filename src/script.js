// Configurações e variáveis globais
const API_BASE_URL = "/api/v1";
const API_BUILD_URL_TO_REDIRECT = "/build-url-to-redirect";
let apiToken = "";
let accountId = "";
let customEtapas = ["Aguardando...", "Lead", "Contato Inicial", "Apresentação", "Proposta", "Negociação", "Fechado Ganho", "Fechado Perdido"];

// Elementos DOM
const loadDataBtn = document.getElementById("load-data");
const apiTokenInput = document.getElementById("api-token");
const accountIdInput = document.getElementById("account-id");
const toggleApiTokenBtn = document.getElementById("toggle-api-token");
const modal = document.getElementById("conversation-modal");
const closeModalBtn = document.querySelector(".close");
const conversationDetails = document.getElementById("conversation-details");

// Inicialização
document.addEventListener("DOMContentLoaded", async () => {
  // Event listeners básicos
  loadDataBtn.addEventListener("click", loadConversations);
  closeModalBtn.addEventListener("click", () => (modal.style.display = "none"));
  window.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  });
  toggleApiTokenBtn.addEventListener("click", toggleApiTokenVisibility);

  try {
    // 1. Verificar se existem credenciais globais configuradas no backend
    const configRes = await fetch("/api/config");
    const configData = await configRes.json();

    // Ler ID da conta a partir da query string da URL se fornecido (para múltiplos workspaces)
    const urlParams = new URLSearchParams(window.location.search);
    const accountIdFromUrl = urlParams.get("accountId");

    if (configData.hasGlobalCredentials) {
      // Ocultar cabeçalho completo para deixar apenas o canvas do Kanban
      const header = document.querySelector("header");
      if (header) {
        header.style.display = "none";
      }
      
      // Usar credenciais globais (o token será injetado pelo proxy no backend)
      apiToken = "global"; 
      accountId = accountIdFromUrl || configData.accountId || "2";
      
      // Carregar automaticamente
      await loadConversations();
    } else {
      // Fallback: carregar credenciais do localStorage se existirem
      const savedToken = localStorage.getItem("chatwoot_api_token");
      const savedAccountId = localStorage.getItem("chatwoot_account_id");

      if (savedToken) {
        apiTokenInput.value = savedToken;
        apiToken = savedToken;
      }

      if (savedAccountId) {
        accountIdInput.value = savedAccountId;
        accountId = savedAccountId;
      }

      if (savedToken && savedAccountId) {
        await loadConversations();
      }
    }
  } catch (error) {
    console.error("Erro na inicialização do Kanban:", error);
  }
});

// Funções principais
async function loadConversations() {
  if (apiToken !== "global") {
    apiToken = apiTokenInput.value.trim();
    accountId = accountIdInput.value.trim();
  }

  if (!apiToken || !accountId) {
    alert("Por favor, insira o token de API e o ID da conta.");
    return;
  }

  // Verificar se a conta está autorizada nas configurações globais
  try {
    const configRes = await fetch("/api/config");
    const configData = await configRes.json();
    if (configData.enabledAccounts) {
      const enabledList = configData.enabledAccounts.split(",").map(id => id.trim());
      if (!enabledList.includes(accountId.toString())) {
        const header = document.querySelector("header");
        if (header) header.style.display = "none";
        const container = document.getElementById("kanban-container");
        container.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 80vh; color: #556070;">
            <i class="fas fa-lock" style="font-size: 3rem; margin-bottom: 1rem; color: #ff5c5c;"></i>
            <h2>Acesso Restrito</h2>
            <p style="margin-top: 0.5rem; text-align: center;">Este recurso (CRM Kanban) não está habilitado para esta conta/workspace.<br>Fale com o administrador da plataforma.</p>
          </div>
        `;
        return;
      }
    }
  } catch (e) {
    console.error("Erro ao verificar restrição de contas:", e);
  }

  // Salvar no localStorage se não for credencial global
  if (apiToken !== "global") {
    localStorage.setItem("chatwoot_api_token", apiToken);
    localStorage.setItem("chatwoot_account_id", accountId);
  }

  try {
    showLoading();

    // 1. Verificar e criar atributos personalizados no Chatwoot se necessário (do modelo contact_attribute)
    await checkAndCreateCustomAttributes();

    // 2. Construir colunas dinâmicas no DOM baseadas nas etapas do Kanban
    buildKanbanColumns();

    // 3. Buscar conversas da API do Chatwoot (otimizado sem resolved para não travar o navegador)
    const conversations = await fetchConversations();

    // 4. Distribuir conversas nas colunas
    distributeConversations(conversations);

    // 5. Inicializar o drag and drop com Sortable.js
    initializeSortable();

    // 6. Calcular somatórios de valores e contadores
    recalculateColumnTotals();

    hideLoading();
  } catch (error) {
    console.error("Erro ao carregar o Kanban:", error);
    hideLoading();
    alert(`Erro ao carregar o Kanban: ${error.message}`);
  }
}

// Verifica se os atributos etapa_kanban e valor_venda existem e os cria se necessário (nos Contatos)
async function checkAndCreateCustomAttributes() {
  try {
    const res = await fetch(`${API_BASE_URL}/accounts/${accountId}/custom_attribute_definitions`, {
      headers: { 
        api_access_token: apiToken,
        "Content-Type": "application/json"
      }
    });
    
    if (!res.ok) {
      console.warn("Não foi possível buscar as definições de atributos personalizados do Chatwoot.");
      return;
    }
    
    const definitions = await res.json();
    
    // Filtrar apenas do modelo de contato (contact_attribute)
    const contactDefinitions = definitions.filter(d => d.attribute_model === "contact_attribute");
    
    const etapaDef = contactDefinitions.find(d => d.attribute_key === "etapa_kanban");
    const valorDef = contactDefinitions.find(d => d.attribute_key === "valor_venda");
    
    if (!etapaDef) {
      console.log("Criando atributo personalizado de contato 'etapa_kanban' no Chatwoot...");
      const createRes = await fetch(`${API_BASE_URL}/accounts/${accountId}/custom_attribute_definitions`, {
        method: "POST",
        headers: {
          api_access_token: apiToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          custom_attribute_definition: {
            attribute_display_name: "Etapa Kanban",
            attribute_key: "etapa_kanban",
            attribute_display_type: "list",
            attribute_model: "contact_attribute",
            attribute_values: customEtapas
          }
        })
      });
      if (!createRes.ok) {
        console.error("Falha ao criar o atributo de contato 'etapa_kanban'. Usando etapas padrão.");
      }
    } else {
      // Garantir que a primeira opção seja 'Aguardando...' se ela não existir
      let remoteEtapas = etapaDef.attribute_values || [];
      if (remoteEtapas.length > 0) {
        if (!remoteEtapas.includes("Aguardando...")) {
          remoteEtapas = ["Aguardando...", ...remoteEtapas];
        }
        customEtapas = remoteEtapas;
      }
    }
    
    if (!valorDef) {
      console.log("Criando atributo personalizado de contato 'valor_venda' no Chatwoot...");
      const createRes = await fetch(`${API_BASE_URL}/accounts/${accountId}/custom_attribute_definitions`, {
        method: "POST",
        headers: {
          api_access_token: apiToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          custom_attribute_definition: {
            attribute_display_name: "Valor da Venda",
            attribute_key: "valor_venda",
            attribute_display_type: "currency",
            attribute_model: "contact_attribute"
          }
        })
      });
      if (!createRes.ok) {
        console.error("Falha ao criar o atributo de contato 'valor_venda'.");
      }
    }
  } catch (e) {
    console.error("Erro na verificação de atributos personalizados:", e);
  }
}

// Cria a estrutura de colunas do Kanban de forma dinâmica no HTML
function buildKanbanColumns() {
  const container = document.getElementById("kanban-container");
  container.innerHTML = "";
  
  // Demais etapas cadastradas (a primeira delas será "Aguardando...")
  customEtapas.forEach(etapa => {
    const slug = slugify(etapa);
    createColumnDOM(etapa, slug);
  });
}

function createColumnDOM(title, slug) {
  const container = document.getElementById("kanban-container");
  const col = document.createElement("div");
  col.className = "kanban-column";
  col.id = `col-${slug}`;
  col.dataset.etapa = title;
  
  col.innerHTML = `
    <h2>
      ${title} 
      <span class="counter">0</span>
      <span class="column-total" id="total-${slug}">R$ 0,00</span>
    </h2>
    <div class="kanban-items"></div>
  `;
  container.appendChild(col);
}

// Busca as conversas do Chatwoot de forma otimizada para evitar travamentos
async function fetchConversations() {
  // Carregamos apenas status ativos. O status "resolved" é omitido por padrão para evitar lentidão
  // já que contas em produção possuem milhares de conversas resolvidas.
  const statuses = ["pending", "open", "snoozed"];
  let allConversations = [];

  for (const status of statuses) {
    try {
      const url = `${API_BASE_URL}/accounts/${accountId}/conversations?status=${status}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          api_access_token: apiToken,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) continue;

      const data = await response.json();
      let conversations = [];
      if (data.data && data.data.payload) {
        conversations = data.data.payload;
      } else {
        conversations = data.data || data.payload || [];
      }

      allConversations = allConversations.concat(conversations);
    } catch (error) {
      console.error(`Erro ao buscar status ${status}:`, error);
    }
  }

  return allConversations;
}

// Distribui os cards nas colunas com base no custom_attribute de Contato
function distributeConversations(conversations) {
  conversations.forEach(conversation => {
    // Ler do Contato remetente
    const contact = conversation.meta?.sender || conversation.sender || {};
    const customAttributes = contact.custom_attributes || {};
    const etapa = customAttributes.etapa_kanban;
    
    // Qualquer contato sem etapa definida vai por padrão para a primeira coluna ("Aguardando...")
    let targetSlug = "aguardando"; 
    if (etapa && customEtapas.includes(etapa)) {
      targetSlug = slugify(etapa);
    }
    
    const column = document.getElementById(`col-${targetSlug}`);
    if (column) {
      const itemsContainer = column.querySelector(".kanban-items");
      const card = createConversationCard(conversation);
      itemsContainer.appendChild(card);
    }
  });
}

function createConversationCard(conversation) {
  const card = document.createElement("div");
  card.className = "kanban-item";
  card.dataset.id = conversation.id;
  
  const contact = conversation.meta?.sender || conversation.sender || {};
  card.dataset.contactId = contact.id; // Guarda o contactId no card para podermos atualizar o contato

  // Guardar valor da venda no dataset para cálculos rápidos locais
  const valorVenda = parseFloat(contact.custom_attributes?.valor_venda) || 0;
  card.dataset.valor = valorVenda;

  // Nome do cliente
  const senderName = contact.name || `Cliente #${conversation.id}`;

  // Data
  let createdAt = new Date();
  if (conversation.created_at) {
    createdAt = new Date(conversation.created_at * 1000);
  }
  const formattedDate = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(createdAt);

  // Última mensagem
  let lastMessage = "Sem mensagens";
  if (conversation.messages && conversation.messages.length > 0) {
    const lastMsg = conversation.messages[conversation.messages.length - 1];
    lastMessage = lastMsg.content || "Mensagem sem texto";
  } else if (conversation.last_non_activity_message?.content) {
    lastMessage = conversation.last_non_activity_message.content;
  }
  const truncatedMessage = lastMessage.length > 60 ? lastMessage.substring(0, 60) + "..." : lastMessage;

  // Valor da Venda formatado
  const formattedVal = valorVenda > 0 
    ? `<span class="card-value">${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valorVenda)}</span>` 
    : '';

  card.innerHTML = `
    <h3>${senderName}</h3>
    <p>${truncatedMessage}</p>
    <div class="meta">
      <span>${formattedDate}</span>
      ${formattedVal}
    </div>
  `;

  // Clique no card abre a conversa no Chatwoot em nova guia
  card.addEventListener("click", (e) => {
    if (e.target.closest(".kanban-item")) {
      redirectToChatwoot(conversation.id, conversation.account_id);
    }
  });

  return card;
}

async function redirectToChatwoot(conversationId, accountIdVal) {
  try {
    const url = `${API_BUILD_URL_TO_REDIRECT}?accountId=${accountIdVal}&conversationId=${conversationId}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.url) {
      // Abre a conversa do Chatwoot pai
      window.open(data.url, "_blank");
    }
  } catch (error) {
    console.error("Erro ao redirecionar:", error);
  }
}

// Inicializa o Sortable.js em cada coluna
function initializeSortable() {
  const columns = document.querySelectorAll(".kanban-column");
  columns.forEach(column => {
    const itemsContainer = column.querySelector(".kanban-items");
    
    new Sortable(itemsContainer, {
      group: "kanban",
      animation: 150,
      ghostClass: "sortable-ghost",
      onEnd: async function (evt) {
        const itemId = evt.item.dataset.id;
        const contactId = evt.item.dataset.contactId;
        const targetColumn = evt.to.parentElement;
        const newEtapa = targetColumn.dataset.etapa;

        if (itemId && contactId) {
          // Atualiza a etapa do CONTATO no Chatwoot e depois recalcula totais locais
          await updateContactEtapa(contactId, newEtapa);
          recalculateColumnTotals();
        }
      },
    });
  });
}

// Faz requisição PUT para atualizar a etapa_kanban no contato
async function updateContactEtapa(contactId, newEtapa) {
  try {
    const url = `${API_BASE_URL}/accounts/${accountId}/contacts/${contactId}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        api_access_token: apiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        custom_attributes: {
          etapa_kanban: newEtapa
        }
      }),
    });

    if (!response.ok) {
      throw new Error(`Erro ao mover contato na API do Chatwoot: ${response.status}`);
    }
  } catch (error) {
    console.error("Erro ao atualizar etapa do contato:", error);
    alert("Erro ao salvar alteração de etapa no Chatwoot. Recarregando dados...");
    loadConversations();
  }
}

// Recalcula contadores e soma do valor_venda por coluna localmente
function recalculateColumnTotals() {
  const columns = document.querySelectorAll(".kanban-column");
  columns.forEach(column => {
    const counter = column.querySelector(".counter");
    const totalSpan = column.querySelector(".column-total");
    const items = column.querySelectorAll(".kanban-item");
    
    counter.textContent = items.length;
    
    let totalSum = 0;
    items.forEach(item => {
      const val = parseFloat(item.dataset.valor) || 0;
      totalSum += val;
    });
    
    totalSpan.textContent = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totalSum);
  });
}

// Helpers
function showLoading() {
  document.getElementById('loading-overlay').style.display = 'flex';
}

function hideLoading() {
  document.getElementById('loading-overlay').style.display = 'none';
}

function slugify(text) {
  return text.toString().toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');
}

function toggleApiTokenVisibility() {
  const icon = toggleApiTokenBtn.querySelector('i');
  
  if (apiTokenInput.type === 'password') {
    apiTokenInput.type = 'text';
    icon.className = 'fas fa-eye-slash';
    toggleApiTokenBtn.title = 'Esconder Token';
  } else {
    apiTokenInput.type = 'password';
    icon.className = 'fas fa-eye';
    toggleApiTokenBtn.title = 'Mostrar Token';
  }
}
