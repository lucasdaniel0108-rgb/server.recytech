# Projeto Login

Exemplo de cadastro e autenticação com Node.js, Express, EJS e SQLite.

## Executar no Windows

Requer Node.js 24 ou superior. Na pasta do projeto:

```powershell
npm install
npm start
```

Abra http://localhost:3000 e clique em **Criar conta**. Não há usuário ou senha padrão. O cadastro exige uma senha de 12 a 128 caracteres.

Para reiniciar automaticamente ao alterar arquivos:

```powershell
npm run dev
```

## Banco de dados

O arquivo `data/login.sqlite` é criado automaticamente. As tabelas `users` e `sessions` armazenam os usuários e as sessões. Os dados permanecem após reiniciar o servidor. O SQLite integrado ao Node.js não exige instalar um servidor de banco separado; o Node pode emitir um aviso de API experimental.

Por padrão, o segredo de sessão é gerado a cada inicialização e as sessões anteriores deixam de ser reconhecidas. Para manter o login entre reinicializações, configure um segredo estável antes de executar:

```powershell
$env:SESSION_SECRET = 'substitua-por-um-segredo-aleatorio-com-32-ou-mais-caracteres'
npm start
```

Gere um segredo com `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Não publique o segredo.

## Estrutura

- `server.js`: banco, sessões, rotas e autenticação.
- `views/auth.ejs`: formulários de login e cadastro.
- `views/dashboard.ejs`: página protegida.
- `public/style.css`: interface responsiva.
- `test/auth.test.js`: testes de integração.

## Rotas

| Método | Rota | Função |
| --- | --- | --- |
| GET | `/login` | Formulário de entrada |
| POST | `/login` | Autenticar |
| GET | `/cadastro` | Formulário de cadastro |
| POST | `/cadastro` | Criar conta e entrar |
| GET | `/painel` | Página autenticada |
| POST | `/logout` | Encerrar sessão |

## Testes

```powershell
npm test
```

Os testes utilizam SQLite em memória e não alteram os dados locais. Cobrem cadastro, validação, e-mail duplicado, senha incorreta, acesso protegido, CSRF, escape de HTML, tentativa de injeção SQL, limite de tentativas e logout.

## Autenticação

Senhas são armazenadas com scrypt e salt aleatório. Consultas SQL usam parâmetros. As sessões são regeneradas após autenticação; cookies são HttpOnly e SameSite=Lax. Formulários POST exigem token CSRF, e cadastro e login têm limite compartilhado de 20 tentativas por IP a cada 15 minutos.

Este projeto é uma base local de treinamento. Não inclui recuperação de senha, verificação de e-mail ou autenticação multifator. Para produção, use HTTPS, defina NODE_ENV=production e SESSION_SECRET (mínimo de 32 caracteres); os cookies exigirão conexão segura. Se houver proxy reverso, configure `trust proxy` conforme a topologia real antes de publicar. O limitador atual opera por processo.
