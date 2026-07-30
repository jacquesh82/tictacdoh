// Importé pour son effet de bord : c'est ce module qui installe
// `window.Capacitor`. Sans lui, tout événement émis par un plugin natif vers
// le JavaScript lève « Cannot read properties of undefined (reading
// 'triggerEvent') » — erreur constatée sur appareil, et qui rendait le pont
// natif inutilisable dans un sens.
import '@capacitor/core'
import { parseJoinInput } from '@ttd/join'
import { renderDiag } from './diag.js'
import { renderHome } from './home.js'
import { renderNet } from './net-view.js'
import { DEFAULT_GAME_ID } from '@ttd/games'
import { loadDeviceName } from './device.js'
import { renderPlay } from './play.js'

const app = document.querySelector<HTMLElement>('#app')!
let disposeCurrent: (() => void) | undefined

// Le nom système traverse le pont natif : on l'obtient une fois, tôt, pour
// que les annonces construites plus tard n'aient pas à attendre.
void loadDeviceName()

function navigate(route: string): void {
  if (globalThis.location.hash === route) render()
  else globalThis.location.hash = route
}

function render(): void {
  disposeCurrent?.()
  disposeCurrent = undefined

  const hash = globalThis.location.hash || '#/'

  // Un lien universel ouvert dans le navigateur arrive ici sous forme de
  // chemin, pas de hash : on le convertit avant le routage pour que scanner un
  // QR et coller un lien mènent exactement au même endroit.
  const path = globalThis.location.pathname
  if (path.startsWith('/j/')) {
    try {
      const parsed = parseJoinInput(globalThis.location.href)
      if (parsed.kind === 'ticket') {
        app.innerHTML = `<h1>Invitation</h1>
          <p class="lede">« ${parsed.ticket.hostName} » vous invite.</p>
          <section class="card">
            <p>Code de la partie : <b>${parsed.ticket.code}</b></p>
            <p class="muted">
              ${parsed.ticket.transports.length} transport(s) proposé(s).
              La connexion effective attend le relay (phase 7).
            </p>
            <div class="row"><a href="#/"><button class="primary">Retour</button></a></div>
          </section>`
        return
      }
    } catch (error) {
      app.innerHTML = `<h1>Invitation illisible</h1><p class="error">${(error as Error).message}</p>`
      return
    }
  }

  if (hash.startsWith('#/diag')) {
    disposeCurrent = renderDiag(
      app,
      hash === '#/diag/detail' ? 'detail' : hash === '#/diag/config' ? 'config' : 'simple',
    )
    return
  }

  if (hash.startsWith('#/host')) {
    // Le nom de salle voyage dans le hash : c'est la seule façon de le passer
    // sans état partagé entre écrans, et un rechargement le préserve.
    const label = new URLSearchParams(hash.slice(hash.indexOf('?') + 1)).get('nom') ?? ''
    disposeCurrent = renderNet(app, 'host', undefined, label)
    return
  }

  const joinMatch = /^#\/join\/([0-9]{4,9})$/.exec(hash)
  if (joinMatch) {
    disposeCurrent = renderNet(app, 'join', joinMatch[1])
    return
  }

  // Le jeu fait partie de la route : recharger la page ou partager le lien
  // redonne la même partie, ce qu'un choix gardé en mémoire ne permettrait pas.
  const playMatch = /^#\/play\/(\d)(?:\/([\w-]+))?$/.exec(hash)
  if (playMatch) {
    const playerCount = Math.min(4, Math.max(1, Number(playMatch[1])))
    disposeCurrent = renderPlay(app, { playerCount, gameId: playMatch[2] ?? DEFAULT_GAME_ID })
    return
  }

  disposeCurrent = renderHome(app, navigate)
}

globalThis.addEventListener('hashchange', render)
render()
