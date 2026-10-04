# Ammara Younas: portfolio

The public site lives at **https://ammara-younas.pages.dev**, and the admin view is at **/admin**.

Everything is free. Cloudflare Pages hosts the site and runs the admin login, and GitHub stores the content. There's no database or server that can go to sleep.

## How it works

| Part | What it does |
|---|---|
| `content/` | Everything the admin view edits: pieces, sections, role pages, jobs and `settings.yml` (the profile). |
| `public/files/` | Uploaded files (Word, PDF, Markdown, text, CVs, photo). |
| `build.py` | Builds the site into `dist/`. Word files become web text, PDF pages become images plus a text version, links become preview cards, and it also writes the search index and sitemap. |
| `templates/`, `public/assets/` | The design of the public site. |
| `functions/`, `lib/server.js` | The admin API on Cloudflare: login, reading content, saving, uploads, publishing and link previews. |
| `public/admin/` | The admin view itself (plain JavaScript, no build step). |

**Saving** in the admin view creates a commit that starts with `[CF-Pages-Skip]`, so Cloudflare doesn't rebuild. **Publish** creates a commit without that flag, which makes Cloudflare build and deploy the site, usually in a minute or two. The admin view checks `/build.json` to show when the change is live.

## One-time setup (about 15 minutes)

### 1. Create a GitHub token for the admin view

1. Open github.com, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens**, and select **Generate new token**.
2. Fill in the token settings:
   - **Name:** `portfolio admin`
   - **Expiration:** *No expiration*. If you pick a date, set yourself a reminder to replace the token before it runs out.
   - **Repository access:** *Only select repositories*, then `fortyTwo102/portfolio`.
   - **Permissions → Repository permissions → Contents:** *Read and write*.
3. Generate the token and copy it. It starts with `github_pat_`.

### 2. Create the Cloudflare Pages project

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and create a free account. Then go to **Workers & Pages → Create → Pages → Connect to Git**, authorize GitHub, and pick `fortyTwo102/portfolio`.
2. Enter the build settings:
   - **Project name:** `ammara-younas`. This becomes the address ammara-younas.pages.dev.
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:**
     ```
     pip install -r requirements.txt && (pip install pypandoc-binary || true) && python build.py
     ```
   - **Build output directory:** `dist`
3. Under **Environment variables (advanced)**, add the variables below. Choose *Encrypt* for the ones marked secret.

   | Name | Value |
   |---|---|
   | `ADMIN_USERNAME` | The shared username |
   | `ADMIN_PASSWORD` (secret) | The shared password. Make it long: four or more random words, or 16+ characters. |
   | `SESSION_SECRET` (secret) | Any long random string (40+ characters from a password generator) |
   | `GITHUB_TOKEN` (secret) | The token from step 1 |
   | `GITHUB_REPO` | `fortyTwo102/portfolio` |
   | `SITE_URL` | `https://ammara-younas.pages.dev`. Change this only if Cloudflare gives the project a different address. |

4. Select **Save and Deploy**. When the deploy finishes, open `/admin`, log in, add a piece and select **Publish**.

If you add or change a variable later, it takes effect only after a new deploy. To redeploy, go to **Deployments**, open the latest deployment's menu and choose **Retry deployment**.

## Using the admin view

- **Add a piece:** go to **Pieces → Add a piece**. Give it a title and sections, then add the work: upload files (PDF, .docx, .md, .txt, up to 20 MB each), add a link, or paste the text. Fill in the specimen label (job, role, brief, result) and **Save**. Then select **Publish** at the top.
- **Visibility:** *Public* pieces are listed everywhere. *Unlisted* pieces work only for people who have the link, and you can still pin them to a role page. *Draft* pieces stay off the site.
- **Role pages:** go to **Role pages** for the link to put on each tailored CV, for example `ammara-younas.pages.dev/for/copywriter/`. You can pin samples there and attach the matching CV PDF.
- **Profile:** the home-page introduction, results, contact details, About page, education, publications and honours.
- If two people save the same thing at once, the second save is refused with a message to reload. Nothing is overwritten silently.

## Changing the password

Change `ADMIN_PASSWORD` in Cloudflare and redeploy. Changing it signs everyone out.

## Local preview

You need Python 3.11+ and Node 20+:

```
pip install -r requirements.txt
python build.py
cp .dev.vars.example .dev.vars   # then fill it in
node scripts/dev.mjs             # http://localhost:8788, admin at /admin
```

With a real `GITHUB_TOKEN` in `.dev.vars`, the local admin view edits the real repository.

## Things to know

- **The repository is public,** so drafts and unlisted pieces can be read on GitHub. To keep them private, make the repository private. The token and Cloudflare keep working.
- **Hand-editing content:** the admin view writes one `key: value` per line in content files. If you edit a file on GitHub, keep that format.
- **Free-plan limits:** each Publish uses one of Cloudflare's 500 free builds a month, and each file can be up to 25 MiB (the admin view caps uploads at 20 MB).
- **Word conversion:** Word files are converted with pandoc when it installs during the build. If it doesn't install, the build falls back to a simpler converter that keeps headings, lists, links and tables but not images.
