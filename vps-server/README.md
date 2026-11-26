# Vigia VPS Server (Google OAuth + Allowlist + Sync)

Servidor leve (zero dependências externas, Node.js >= 22.5 + SQLite nativo) para rodar no seu notebook como VPS via **Tailscale Funnel**.

Ele armazena apenas:
- Lista de Gmails autorizados (`allowed_emails`) e papéis (`admin` / `user`)
- Dados básicos de login dos usuários (`users` e `sessions`)
- Produtos monitorados e preferências das configurações de cada usuário (`user_data`)

---

## 1. Expor a porta com Tailscale Funnel (no notebook)

```bash
tailscale funnel 4400
```

O Tailscale vai exibir sua URL pública HTTPS, algo como:
`https://meu-notebook.tail12345.ts.net`

---

## 2. Configurar Google OAuth no Google Cloud Console

1. Acesse [Google Cloud Console → APIs e Serviços → Credenciais](https://console.cloud.google.com/apis/credentials).
2. Configure a **Tela de permissão OAuth** (Tipo: Externo; escopos: `openid`, `email`, `profile`).
3. Crie um **ID do cliente OAuth** (Tipo: **Aplicativo da Web**).
4. Em **URIs de redirecionamento autorizados**, adicione:
   ```
   https://seu-notebook.sua-tailnet.ts.net/auth/google/callback
   ```
5. Copie o **Client ID** e o **Client Secret**.

---

## 3. Configurar e iniciar o VPS (no notebook)

```bash
cd vps-server
cp .env.example .env
```

Edite `vps-server/.env`:
```env
PORT=4400
HOST=127.0.0.1
PUBLIC_BASE_URL=https://seu-notebook.sua-tailnet.ts.net
GOOGLE_CLIENT_ID=seu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=seu-client-secret
ADMIN_EMAILS=seuemail@gmail.com
```

Inicie o servidor:
```bash
npm start
```

---

## 4. Conectar o painel Vigia local (`interface/`) ao VPS

Na máquina onde o Vigia roda:
```bash
cd interface
cp .env.example .env
```

Edite `interface/.env`:
```env
VIGIA_VPS_URL=https://seu-notebook.sua-tailnet.ts.net
```

Ao abrir o Vigia (`INICIAR-PAINEL.cmd` ou `npm start` em `interface/`), ele exibirá o botão **Entrar com Google**.

---

## 5. Gerenciar Gmails autorizados

Você pode gerenciar de duas formas:
1. **Pelo próprio painel Vigia**: como `admin`, abra **Configurações → Acessos (Admin)** para adicionar ou remover Gmails.
2. **Pelo terminal no notebook**:
   ```bash
   cd vps-server
   node cli.mjs list
   node cli.mjs add amigo@gmail.com user "Conta do amigo"
   node cli.mjs remove amigo@gmail.com
   ```

---

## 6. Publicar atualizações automáticas (estilo Discord)

1. Atualize o número da versão em `interface/package.json` (ex.: `"version": "0.12.0"`).
2. No notebook (VPS), empacote e publique a nova versão com um único comando:
   ```bash
   cd vps-server
   node cli.mjs pack 0.12.0 "Correções e melhorias"
   ```
   (Ou, se já tiver um `.tar.gz` pronto: `node cli.mjs publish 0.12.0 caminho/arquivo.tar.gz "Notas"`.)

Assim que qualquer usuário logar ou abrir o Vigia com o VPS online, o app baixa o pacote, valida o **SHA-256**, instala preservando `.data/` e `.env`, e reinicia automaticamente.

