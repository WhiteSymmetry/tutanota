// @flow
import {serviceRequest, serviceRequestVoid, load, update, loadRoot} from "../EntityWorker"
import {SysService} from "../../entities/sys/Services"
import {
	base64ToBase64Url,
	base64ToUint8Array,
	utf8Uint8ArrayToString,
	uint8ArrayToBase64,
	base64UrlToBase64,
	base64ToBase64Ext
} from "../../common/utils/Encoding"
import {generateKeyFromPassphrase, generateRandomSalt} from "../crypto/Bcrypt"
import {KeyLength} from "../crypto/CryptoConstants"
import {createAuthVerifierAsBase64Url, createAuthVerifier, base64ToKey, keyToUint8Array} from "../crypto/CryptoUtils"
import {decryptKey, encryptKey, encryptBytes, encryptString} from "../crypto/CryptoFacade"
import type {GroupTypeEnum} from "../../common/TutanotaConstants"
import {GroupType, OperationType, AccountType} from "../../common/TutanotaConstants"
import {aes128Decrypt, aes128RandomKey} from "../crypto/Aes"
import {random} from "../crypto/Randomizer"
import {CryptoError} from "../../common/error/CryptoError"
import {createSaltData} from "../../entities/sys/SaltData"
import {SaltReturnTypeRef} from "../../entities/sys/SaltReturn"
import {GroupInfoTypeRef} from "../../entities/sys/GroupInfo"
import {TutanotaPropertiesTypeRef} from "../../entities/tutanota/TutanotaProperties"
import {UserTypeRef} from "../../entities/sys/User"
import {createReceiveInfoServiceData} from "../../entities/tutanota/ReceiveInfoServiceData"
import {neverNull} from "../../common/utils/Utils"
import {isSameTypeRef, TypeRef, isSameId, HttpMethod, GENERATED_ID_BYTES_LENGTH} from "../../common/EntityFunctions"
import {assertWorkerOrNode} from "../../Env"
import {hash} from "../crypto/Sha256"
import {module as replaced} from "@hot"
import {createChangePasswordData} from "../../entities/sys/ChangePasswordData"
import {EventBusClient} from "../EventBusClient"
import {createCreateSessionData} from "../../entities/sys/CreateSessionData"
import {CreateSessionReturnTypeRef} from "../../entities/sys/CreateSessionReturn"
import {SessionTypeRef, _TypeModel as SessionModelType} from "../../entities/sys/Session"
import {typeRefToPath} from "../rest/EntityRestClient"
import {restClient, MediaType} from "../rest/RestClient"
import {NotAuthenticatedError, ConnectionError} from "../../common/error/RestError"
import {createSecondFactorAuthGetData} from "../../entities/sys/SecondFactorAuthGetData"
import {SecondFactorAuthGetReturnTypeRef} from "../../entities/sys/SecondFactorAuthGetReturn"
import {workerImpl} from "../WorkerImpl"
import {SecondFactorPendingError} from "../../common/error/SecondFactorPendingError"

assertWorkerOrNode()

export const state = replaced ? replaced.state : {}

export class LoginFacade {
	_user: ?User;
	_userGroupInfo: ?GroupInfo;
	_accessToken: ?string;
	_authVerifierAfterNextRequest: ?Base64Url; // needed for password changes
	groupKeys: {[key:Id] : Aes128Key};
	_eventBusClient: EventBusClient;
	_persistentSession: boolean;

	constructor() {
		this._reset()
	}

	createSession(mailAddress: string, passphrase: string, clientIdentifier: string, returnCredentials: boolean): Promise<{user:User, userGroupInfo: GroupInfo, sessionElementId: Id, credentials: ?Credentials}> {
		if (this._user) {
			console.log("session already exists, reuse data")
			// do not reset here because the event bus client needs to be kept if the same user is logged in as before
			// check if it is the same user in _initSession()
		}
		console.log("createSession worker")
		this._persistentSession = returnCredentials
		return this._loadUserPassphraseKey(mailAddress, passphrase).then(userPassphraseKey => {
			// the verifier is always sent as url parameter, so it must be url encoded
			let authVerifier = createAuthVerifierAsBase64Url(userPassphraseKey)
			let sessionData = createCreateSessionData();
			sessionData.mailAddress = mailAddress.toLowerCase().trim()
			sessionData.clientIdentifier = clientIdentifier
			sessionData.authVerifier = authVerifier
			let accessKey = null
			if (returnCredentials) {
				accessKey = aes128RandomKey()
				sessionData.accessKey = keyToUint8Array(accessKey)
			}
			return serviceRequest(SysService.SessionService, HttpMethod.POST, sessionData, CreateSessionReturnTypeRef).catch(ConnectionError, e => {
				// IE11 shows not connected error when not authenticated is received at login (xmlhttprequest.onerror is called although network view shows 401 response code)
				if (typeof navigator == "object" && navigator.userAgent && navigator.userAgent.indexOf("Trident/7.0") != -1) {
					throw new NotAuthenticatedError("not connected error at login in IE -> NotAuthenticatedError")
				} else {
					throw e
				}
			}).then(createSessionReturn => {
				let p = Promise.resolve()
				if (createSessionReturn.challenges.length > 0) {
					let sessionId = [this._getSessionListId(createSessionReturn.accessToken), this._getSessionElementId(createSessionReturn.accessToken)]
					workerImpl.sendError(new SecondFactorPendingError(sessionId, createSessionReturn.challenges)) // show a notification to the user
					p = this._waitUntilSecondFactorApproved(createSessionReturn.accessToken)
				}
				return p.then(() => {
					return this._initSession(createSessionReturn.user, createSessionReturn.accessToken, userPassphraseKey).then(() => {
						return {
							user: neverNull(this._user),
							userGroupInfo: neverNull(this._userGroupInfo),
							sessionElementId: this._getSessionElementId(neverNull(this._accessToken)),
							credentials: (accessKey) ? {
									mailAddress,
									accessToken: neverNull(this._accessToken),
									encryptedPassword: uint8ArrayToBase64(encryptString(accessKey, passphrase))
								} : null
						}
					})
				})
			})
		})
	}

	_waitUntilSecondFactorApproved(accessToken: Base64Url): Promise<void> {
		let secondFactorAuthGetData = createSecondFactorAuthGetData()
		secondFactorAuthGetData.accessToken = accessToken
		return serviceRequest(SysService.SecondFactorAuthService, HttpMethod.GET, secondFactorAuthGetData, SecondFactorAuthGetReturnTypeRef).then(secondFactorAuthGetReturn => {
			if (secondFactorAuthGetReturn.secondFactorPending) {
				return this._waitUntilSecondFactorApproved(accessToken)
			}
		})
	}

	createExternalSession(userId: Id, passphrase: string, salt: Uint8Array, clientIdentifier: string, returnCredentials: boolean): Promise<{user:User, userGroupInfo: GroupInfo, sessionElementId: Id, credentials: ?Credentials}> {
		if (this._user) {
			throw new Error("user already logged in")
		}
		console.log("login external worker")
		let userPassphraseKey = generateKeyFromPassphrase(passphrase, salt, KeyLength.b128)
		// the verifier is always sent as url parameter, so it must be url encoded
		let authVerifier = createAuthVerifierAsBase64Url(userPassphraseKey)
		let authToken = base64ToBase64Url(uint8ArrayToBase64(hash(salt)));

		let sessionData = createCreateSessionData();
		sessionData.user = userId
		sessionData.authToken = authToken
		sessionData.clientIdentifier = clientIdentifier
		sessionData.authVerifier = authVerifier
		let accessKey = null
		if (returnCredentials) {
			accessKey = aes128RandomKey()
			sessionData.accessKey = keyToUint8Array(accessKey)
		}
		return serviceRequest(SysService.SessionService, HttpMethod.POST, sessionData, CreateSessionReturnTypeRef).then(createSessionReturn => {
			return this._initSession(createSessionReturn.user, createSessionReturn.accessToken, userPassphraseKey).then(() => {
				return {
					user: neverNull(this._user),
					userGroupInfo: neverNull(this._userGroupInfo),
					sessionElementId: this._getSessionElementId(neverNull(this._accessToken)),
					credentials: (accessKey) ? {
							mailAddress: userId, // we set the external user id because we do not have the mail address
							accessToken: neverNull(this._accessToken),
							encryptedPassword: uint8ArrayToBase64(encryptString(accessKey, passphrase))
						} : null
				}
			})
		})
	}

	/**
	 * Resume a session of stored credentials.
	 */
	resumeSession(credentials: Credentials, externalUserSalt: ?Uint8Array): Promise<{user:User, userGroupInfo: GroupInfo, sessionElementId: Id}> {
		console.log("resumeSession worker")
		return this._loadSessionData(credentials.accessToken).then(sessionData => {
			let passphrase = utf8Uint8ArrayToString(aes128Decrypt(sessionData.accessKey, base64ToUint8Array(credentials.encryptedPassword)))
			let passphraseKeyPromise: Promise<Aes128Key>
			if (externalUserSalt) {
				passphraseKeyPromise = Promise.resolve(generateKeyFromPassphrase(passphrase, externalUserSalt, KeyLength.b128))
			} else {
				passphraseKeyPromise = this._loadUserPassphraseKey(credentials.mailAddress, passphrase)
			}
			return passphraseKeyPromise.then(userPassphraseKey => {
				return this._initSession(sessionData.userId, credentials.accessToken, userPassphraseKey).then(() => {
					this._persistentSession = true
					return {
						user: neverNull(this._user),
						userGroupInfo: neverNull(this._userGroupInfo),
						sessionElementId: this._getSessionElementId(neverNull(this._accessToken))
					}
				})
			})
		})
	}

	_initSession(userId: Id, accessToken: Base64Url, userPassphraseKey: Aes128Key): Promise<void> {
		if (this._user && userId != this._user._id) {
			throw new Error("different user is tried to login in existing other user's session")
		}
		this._accessToken = accessToken
		return load(UserTypeRef, userId).then(user => {
			state.user = user
			this._user = user
			this.groupKeys[this.getUserGroupId()] = decryptKey(userPassphraseKey, this._user.userGroup.symEncGKey)
			return load(GroupInfoTypeRef, user.userGroup.groupInfo)
		}).then(groupInfo => this._userGroupInfo = groupInfo)
			.then(() => this.loadEntropy())
			.then(() => this._getInfoMails())
			.then(() => this._eventBusClient.connect(false))
			.catch(e => {
				this._reset()
				throw e
			})
	}

	_reset() {
		this._user = null
		this._userGroupInfo = null
		this._accessToken = null
		this._authVerifierAfterNextRequest = null
		this.groupKeys = {}
		if (this._eventBusClient) {
			this._eventBusClient.close()
		}
		this._eventBusClient = new EventBusClient()
		this._persistentSession = false
	}

	_loadUserPassphraseKey(mailAddress: string, passphrase: string): Promise<Aes128Key> {
		mailAddress = mailAddress.toLowerCase().trim()
		let saltRequest = createSaltData()
		saltRequest.mailAddress = mailAddress
		return serviceRequest(SysService.SaltService, HttpMethod.GET, saltRequest, SaltReturnTypeRef).then((saltReturn: SaltReturn) => {
			return generateKeyFromPassphrase(passphrase, saltReturn.salt, KeyLength.b128)
		})
	}

	_getInfoMails() {
		if (!this.isExternalUserLoggedIn()) {
			let receiveInfoData = createReceiveInfoServiceData()
			return serviceRequestVoid("receiveinfoservice", HttpMethod.POST, receiveInfoData)
		}
	}

	logout(): Promise<void> {
		if (!this._user) {
			console.log("logout without login")
			return Promise.resolve()
		}
		const user = this._user
		console.log("logout worker")
		// close the event bus client before resetting this login facade to make sure the event bus does not try to handle the TutanotaProperties update triggered by storeEntropy()
		this._eventBusClient.close()
		return this.storeEntropy()
			.catch(e => console.log("could not store entropy", e))
			.finally(() => {
				let promise = Promise.resolve()
				if (!this._persistentSession) {
					promise = this.deleteSession(neverNull(this._accessToken))
				}
				return promise.finally(() => {
					this._reset()
				})
			})
	}

	/**
	 * We use the accessToken that should be deleted for authentication. Therefore it can be invoked while logged in or logged out.
	 */
	deleteSession(accessToken: Base64Url): Promise<void> {
		let path = typeRefToPath(SessionTypeRef) + '/' + this._getSessionListId(accessToken) + "/" + this._getSessionElementId(accessToken)
		let headers = {
			'accessToken': accessToken,
			"v": SessionModelType.version
		}
		return restClient.request(path, HttpMethod.DELETE, {}, headers, null, MediaType.Json).catch(NotAuthenticatedError, () => {
			console.log("authentication failed => session is already deleted")
		})
	}

	_getSessionElementId(accessToken: Base64Url): Id {
		let byteAccessToken = base64ToUint8Array(base64UrlToBase64(neverNull(accessToken)))
		return base64ToBase64Url(uint8ArrayToBase64(hash(byteAccessToken.slice(GENERATED_ID_BYTES_LENGTH))))
	}

	_getSessionListId(accessToken: Base64Url): Id {
		let byteAccessToken = base64ToUint8Array(base64UrlToBase64(neverNull(accessToken)))
		return base64ToBase64Ext(uint8ArrayToBase64(byteAccessToken.slice(0, GENERATED_ID_BYTES_LENGTH)))
	}


	_loadSessionData(accessToken: Base64Url): Promise<{userId:Id, accessKey:Aes128Key}> {
		let path = typeRefToPath(SessionTypeRef) + '/' + this._getSessionListId(accessToken) + "/" + this._getSessionElementId(accessToken)
		let headers = {
			'accessToken': accessToken,
			"v": SessionModelType.version
		}
		return restClient.request(path, HttpMethod.GET, {}, headers, null, MediaType.Json).then(instance => {
			let session = JSON.parse(instance)
			return {userId: session.user, accessKey: base64ToKey(session.accessKey)}
		})
	}

	/**
	 * @return The map which contains authentication data for the logged in user.
	 */
	createAuthHeaders(): Params {
		return this._accessToken ? {
				'accessToken': this._accessToken
			} : {}
	}

	getUserGroupId(): Id {
		return this.getLoggedInUser().userGroup.group
	}

	getAllGroupIds(): Id[] {
		let groups = this.getLoggedInUser().memberships.map(membership => membership.group)
		groups.push(loginFacade.getLoggedInUser().userGroup.group)
		return groups
	}

	getUserGroupKey(): Aes128Key {
		return this.groupKeys[this.getUserGroupId()] // the userGroupKey is always written after the login to this.groupKeys
	}

	getGroupKey(groupId: Id): Aes128Key {
		if (!this.groupKeys[groupId]) {
			this.groupKeys[groupId] = decryptKey(this.groupKeys[this.getUserGroupId()], this._getMembership(groupId).symEncGKey)
		}
		return this.groupKeys[groupId]
	}

	_getMembership(groupId: Id): GroupMembership {
		let membership = this.getLoggedInUser().memberships.find((g: GroupMembership) => g.group === groupId)
		if (!membership) {
			throw new Error(`No group with groupId ${groupId} found!`)
		}
		return membership
	}

	hasGroup(groupId: Id): boolean {
		if (!this._user) {
			return false
		} else {
			return groupId === this._user.userGroup.group || this._user.memberships.find(m => m.group === groupId) != null
		}
	}

	getGroupId(groupType: GroupTypeEnum): Id {
		if (groupType == GroupType.User) {
			return this.getUserGroupId()
		} else {
			let membership = this.getLoggedInUser().memberships.find(m => m.groupType === groupType)
			if (!membership) {
				throw new Error("could not find groupType " + groupType + " for user " + this.getLoggedInUser()._id)
			}
			return membership.group
		}
	}

	isExternalUserLoggedIn() {
		return this._user && this._user.accountType == AccountType.EXTERNAL
	}

	isLoggedIn() {
		return this._user != null
	}

	getLoggedInUser(): User {
		return neverNull(this._user)
	}

	/**
	 * Loads entropy from the last logout.
	 */
	loadEntropy(): Promise<void> {
		return loadRoot(TutanotaPropertiesTypeRef, loginFacade.getUserGroupId()).then(tutanotaProperties => {
			if (tutanotaProperties.groupEncEntropy) {
				try {
					let entropy = aes128Decrypt(loginFacade.getUserGroupKey(), neverNull(tutanotaProperties.groupEncEntropy))
					random.addStaticEntropy(entropy)
				} catch (error) {
					if (error instanceof CryptoError) {
						console.log("could not decrypt entropy", error)
					}
				}
			}
		})
	}

	storeEntropy(): Promise<void> {
		return loadRoot(TutanotaPropertiesTypeRef, loginFacade.getUserGroupId()).then(tutanotaProperties => {
			tutanotaProperties.groupEncEntropy = encryptBytes(loginFacade.getUserGroupKey(), random.generateRandomData(32))
			return update(tutanotaProperties)
		})
	}

	entityEventReceived(data: EntityUpdate): Promise<void> {
		if (this._user && data.operation == OperationType.UPDATE && isSameTypeRef(new TypeRef(data.application, data.type), UserTypeRef) && isSameId(this._user._id, data.instanceId)) {
			return load(UserTypeRef, this._user._id).then(updatedUser => {
				this._user = updatedUser
			})
		} else if (this._userGroupInfo && data.operation == OperationType.UPDATE && isSameTypeRef(new TypeRef(data.application, data.type), GroupInfoTypeRef) && isSameId(this._userGroupInfo._id, [neverNull(data.instanceListId), data.instanceId])) {
			return load(GroupInfoTypeRef, this._userGroupInfo._id).then(updatedUserGroupInfo => {
				this._userGroupInfo = updatedUserGroupInfo
			})
		} else {
			return Promise.resolve()
		}
	}

	changePassword(oldPassword: string, newPassword: string): Promise<void> {
		let oldAuthVerifier = createAuthVerifier(generateKeyFromPassphrase(oldPassword, neverNull(neverNull(this._user).salt), KeyLength.b128))

		let salt = generateRandomSalt();
		let userPassphraseKey = generateKeyFromPassphrase(newPassword, salt, KeyLength.b128)
		let pwEncUserGroupKey = encryptKey(userPassphraseKey, this.getUserGroupKey())
		let authVerifier = createAuthVerifier(userPassphraseKey)
		let authVerifierBase64Url = base64ToBase64Url(uint8ArrayToBase64(authVerifier))

		let service = createChangePasswordData()
		service.oldVerifier = oldAuthVerifier
		service.salt = salt
		service.verifier = authVerifier
		service.pwEncUserGroupKey = pwEncUserGroupKey
		this._authVerifierAfterNextRequest = authVerifierBase64Url
		return serviceRequestVoid(SysService.ChangePasswordService, HttpMethod.POST, service)
	}

	tryReconnectEventBus(): Promise<void> {
		this._eventBusClient.tryReconnect(true);
		return Promise.resolve()
	}
}


export var loginFacade: LoginFacade = new LoginFacade()

if (replaced) {
	Object.assign(loginFacade, replaced.loginFacade)
	loginFacade._eventBusClient.close()
	loginFacade._eventBusClient = new EventBusClient()
	if (loginFacade.isLoggedIn()) {
		loginFacade._eventBusClient.connect(false)
	}
}
