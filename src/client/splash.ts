import {requestExpandedMode} from '@devvit/web/client'
import {installErrorReporting} from './errorReporting.ts'

installErrorReporting('splash')

const startBtn = document.getElementById('start-btn') as HTMLButtonElement
startBtn.addEventListener('click', ev => requestExpandedMode(ev, 'game'))
