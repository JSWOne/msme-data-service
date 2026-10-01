// Multibranch pipeline for msme-data-service.
//   release/gke -> QA,  preprod/gke -> Preprod,  master/gke -> Prod (manual approval)
// Any other branch / PR runs install, lint, test and build only.
//
// Agent requirements: Node 20 + npm, Docker, gcloud CLI, curl, bash.
// Jenkins credentials ("Secret file" holding a GCP service-account JSON key), one per env:
//   gcp-sa-qa, gcp-sa-preprod, gcp-sa-prod

def BRANCH_TO_ENV = [
  'release/gke': 'qa',
  'preprod/gke': 'preprod',
  'master/gke' : 'prod',
]

pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '30'))
    timeout(time: 45, unit: 'MINUTES')
  }

  environment {
    SERVICE_NAME = 'msme-data-service'
  }

  stages {
    stage('Resolve environment') {
      steps {
        script {
          env.DEPLOY_ENV = BRANCH_TO_ENV.get(env.BRANCH_NAME, 'none')
          env.IMAGE_TAG = sh(script: 'git rev-parse --short=12 HEAD', returnStdout: true).trim()
          echo "Branch=${env.BRANCH_NAME} -> env=${env.DEPLOY_ENV}, tag=${env.IMAGE_TAG}"
        }
      }
    }

    stage('Install') {
      steps { sh 'npm ci --no-audit --no-fund' }
    }

    stage('Lint & Test') {
      steps {
        sh 'npm run lint'
        sh 'npm run typecheck'
        sh 'npm test'
      }
    }

    stage('Build') {
      steps { sh 'npm run build' }
    }

    stage('Docker build') {
      when { expression { env.DEPLOY_ENV != 'none' } }
      steps { sh 'docker build --pull -t "${SERVICE_NAME}:${IMAGE_TAG}" .' }
    }

    stage('Image scan') {
      when { expression { env.DEPLOY_ENV != 'none' } }
      steps {
        sh '''
          if command -v trivy >/dev/null 2>&1; then
            trivy image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "${SERVICE_NAME}:${IMAGE_TAG}"
          else
            echo "trivy not installed on agent - skipping image scan"
          fi
        '''
      }
    }

    stage('Approve Prod') {
      when { expression { env.DEPLOY_ENV == 'prod' } }
      steps {
        timeout(time: 2, unit: 'HOURS') {
          input message: "Deploy ${env.SERVICE_NAME}:${env.IMAGE_TAG} to PROD?", ok: 'Deploy'
        }
      }
    }

    stage('Push & Deploy') {
      when { expression { env.DEPLOY_ENV != 'none' } }
      steps {
        withCredentials([file(credentialsId: "gcp-sa-${env.DEPLOY_ENV}", variable: 'GOOGLE_APPLICATION_CREDENTIALS')]) {
          sh 'bash deploy/deploy.sh "${DEPLOY_ENV}" "${IMAGE_TAG}"'
        }
      }
    }
  }

  post {
    always {
      sh 'docker image rm -f "${SERVICE_NAME}:${IMAGE_TAG}" >/dev/null 2>&1 || true'
    }
  }
}
