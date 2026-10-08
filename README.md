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

## One-time setup

### 1. Make a GitHub key for the admin view

Open this link. It fills in the form for you:
https://github.com/settings/personal-access-tokens/new?name=portfolio%20admin&description=Lets%20the%20portfolio%20admin%20view%20save%20changes&expires_in=none&contents=write

1. Under **Repository access**, choose **Only select repositories**, then pick `portfolio`.
2. Check that **Contents** is set to **Read and write** under **Permissions**.
3. Select **Generate token** and copy the key. It starts with `github_pat_`.

### 2. Create the Cloudflare Pages project

1. In [dash.cloudflare.com](https://dash.cloudflare.com), go to **Workers & Pages → Create application → Pages → Connect to Git**. Allow Cloudflare to see the `portfolio` repository and select it.
2. Fill in the settings:
   - **Project name:** `ammara-younas`. This becomes the address ammara-younas.pages.dev.
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** `pip install -r requirements.txt && (pip install pypandoc-binary || true) && python build.py`
   - **Build output directory:** `dist`
3. Select **Save and Deploy**.

### 3. Add three settings

In the project, go to **Settings → Variables and Secrets** and add these three. Choose **Secret** as the type for each one:

| Name | Value |
|---|---|
| `ADMIN_USERNAME` | The shared username |
| `ADMIN_PASSWORD` | The shared password. Make it long: four or more random words, or 16+ characters. |
| `GITHUB_TOKEN` | The key from step 1 |

Then deploy again so the settings take effect. To do that, go to **Deployments**, open the menu on the latest deployment and choose **Retry deployment**. The login page at `/admin` tells you if anything is still missing.

Optional settings, which you only need if something changes: `SITE_URL` if Cloudflare gives the project a different address, `GITHUB_REPO` if the repository is renamed or moved (the default is `fortyTwo102/portfolio`), and `SESSION_SECRET` to sign logins with something other than the GitHub key.

## Using the admin view

- **Sections** (Travel blogs, Web pages, Campaigns, Tripshepherd, Agency websites, PR, Social) are the site's main menu and the tiles on the home page.
  - Click a section to change its name, short menu name, label, introduction, home-page summary and button text.
  - **Layout:** *List* shows one line per piece with topic filters, which suits blogs. *Cards* shows every piece in full, with its text and links, which suits campaigns and agency work.
  - On the Sections list, untick a section to hide it from the home page, and use **Up** and **Down** to reorder.
- **Add a piece:** go to **Pieces → Add a piece**. Give it a title, sections, a place and topics, then add the work: upload files (PDF, .docx, .md, .txt, up to 20 MB each), add one or more links, or paste the text. Save, then select **Publish** at the top.
  - A piece with several links shows them as a list. Give each link a caption, such as the city, and links that share captions are grouped (Canada, USA).
  - **Order:** numbered pieces are listed lowest number first. Pieces with no number come before them, newest first.
- **Visibility:** *Public* pieces are listed everywhere. *Unlisted* pieces work only for people who have the link, and you can still pin them to a role page. *Draft* pieces stay off the site.
- **Role pages:** go to **Role pages** for the link to put on each tailored CV, for example `ammara-younas.pages.dev/for/copywriter/`. You can pin samples there and attach the matching CV PDF.
- **Profile:** the label above her name, headline, introduction, results (each line starts with its number, which is shown large), contact details including the phone number in the footer, About page and education.
- If two people save the same thing at once, the second save is refused with a message to reload. Nothing is overwritten silently.

## Changing the password

Change `ADMIN_PASSWORD` in Cloudflare and deploy again. Changing it signs everyone out. Replacing the GitHub key also signs everyone out.

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
