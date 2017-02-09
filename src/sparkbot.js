'use strict';

const apiai = require('apiai');
const uuid = require('node-uuid');
const request = require('request');

var allowedEmails = ["luca.calabrese@italtel.com","andrea.stella@italtel.com", "stefano.boero@italtel.com", "antonella.clavenna@italtel.com", "gianandrea.mevoli@italtel.com", "camillo.ascione@italtel.com", "giorgio.costantini@italtel.com", "francesca.tiburzi@italtel.com", "vincenzo.vettigli@italtel-consultant.com"];

module.exports = class SparkBot {

	get apiaiService() {
		return this._apiaiService;
	}

	set apiaiService(value) {
		this._apiaiService = value;
	}

	get botConfig() {
		return this._botConfig;
	}

	set botConfig(value) {
		this._botConfig = value;
	}

	get sessionIds() {
		return this._sessionIds;
	}

	set sessionIds(value) {
		this._sessionIds = value;
	}

	constructor(botConfig, webhookUrl) {
		this._botConfig = botConfig;
		var apiaiOptions = {
			language: botConfig.apiaiLang,
			requestSource: "spark"
		};

		this._apiaiService = apiai(botConfig.apiaiAccessToken, apiaiOptions);
		this._sessionIds = new Map();

		this._webhookUrl = webhookUrl;
		console.log('Starting bot on ' + this._webhookUrl);

		this.loadProfile()
		.then((profile) => {
			if (profile.displayName) {
				this._botName = profile.displayName.replace("(bot)", "").trim();
				if (this._botName.includes(" ")) {
					this._shortName = this._botName.substr(0, this._botName.indexOf(" "));
				} else {
					this._shortName = null;
				}

				console.log("BotName:", this._botName);
				console.log("ShortName:", this._shortName);
			}
		});
	}

	setupWebhook() {
		// https://developer.ciscospark.com/endpoint-webhooks-post.html

		// Check if a webhook has already been created for this bot
		console.log("Start webhook check");
		request.get("https://api.ciscospark.com/v1/webhooks", {
			auth: {
				bearer: this._botConfig.sparkToken
			},
			qs: {
				max: 100
			}
		}, (err, resp, body) => {
			if (err) {
				console.error('Error while get webhooks:', err);
				return;
			} else if (resp.statusCode != 200) {
				console.log('LoadMessage error:', resp.statusCode, body);
				return;
			} else {
				console.log("Successful");
				console.log("webhooks", body);
				let result = JSON.parse(body);
				console.log("result", result);
				if (result) {
					let items = result.items;
					if (items) {
						for (var i = 0; i < items.length; i++) {
							console.log("items[i]: ", items[i]);
							if (items[i].targetUrl === this._webhookUrl) {
								console.log("Webhook already present for this bot. Webhook URL: ", items[i].targetUrl);
								return;
							}
						}
					}
				}
				console.log("Start webhook creation");
				request.post("https://api.ciscospark.com/v1/webhooks", {
					auth: {
						bearer: this._botConfig.sparkToken
					},
					json: {
						event: "created",
						name: "BotWebhook",
						resource: "messages",
						targetUrl: this._webhookUrl
					}
				}, (err, resp) => {
					if (err) {
						console.error("Error while setup webhook", err);
						return;
					}

					if (resp.statusCode > 200) {
						let message = resp.statusMessage;
						if (resp.body && resp.body.message) {
							message += ", " + resp.body.message;
						}
						console.error("Error while setup webhook", message);
						return;
					}

					console.log("Webhook result", resp.body);
				});
			}
		});
	}

	loadProfile() {
		return new Promise((resolve, reject) => {
			request.get("https://api.ciscospark.com/v1/people/me", {
				auth: {
					bearer: this._botConfig.sparkToken
				}
			}, (err, resp, body) => {
				if (err) {
					console.error('Error while reply:', err);
					reject(err);
				} else if (resp.statusCode != 200) {
					console.log('LoadMessage error:', resp.statusCode, body);
					reject('LoadMessage error: ' + body);
				} else {

					if (this._botConfig.devConfig) {
						console.log("profile", body);
					}

					let result = JSON.parse(body);
					resolve(result);
				}
			});
		});
	}

	/**
	Process message from Spark
	details here https://developer.ciscospark.com/webhooks-explained.html
	 */
	processMessage(req, res) {
		if (this._botConfig.devConfig) {
			console.log("body", req.body);
		}

		let updateObject = req.body;
		if (updateObject.resource == "messages" &&
			updateObject.data &&
			updateObject.data.id) {

			if (updateObject.data.personEmail && updateObject.data.personEmail.endsWith("@sparkbot.io")) {
				console.log("Message from bot. Skipping.");
				return;
			}
			
			if (updateObject.data.personEmail && allowedEmails.indexOf(updateObject.data.personEmail)==-1) {
				console.log("Message is not from Italtel. Skipping.");
				this.reply(updateObject.data.roomId, updateObject.data.personEmail + ", unfortunately I cannot answer you since you are not authorized.", null);
				SparkBot.createResponse(res, 200, 'Reply sent');
				return;
			}

			this.loadMessage(updateObject.data.id)
			.then((msg) => {
				let messageText = msg.text;
				let chatId = msg.roomId;

				if (messageText && chatId) {
					console.log(chatId, messageText);

					// to remove bot name from message
					if (this._botName) {
						messageText = messageText.replace(this._botName, '');
					}

					if (this._shortName) {
						messageText = messageText.replace(this._shortName, '');
					}

					if (!this._sessionIds.has(chatId)) {
						this._sessionIds.set(chatId, uuid.v1());
					}

					var myContexts = [];
					var context = {};
					context.name='spark';
					context.parameters=[];
					context.parameters.push({roomId:chatId});
					myContexts.push(context);
					
					let apiaiRequest = this._apiaiService.textRequest(messageText, {
							sessionId: this._sessionIds.get(chatId),
							contexts: myContexts
						});

					apiaiRequest.on('response', (response) => {
						if (SparkBot.isDefined(response.result)) {
							let responseText = response.result.fulfillment.speech;
							if (SparkBot.isDefined(responseText)) {
								console.log('Response as text message');
								let messages = response.result.fulfillment.messages;
								let files;
								if(SparkBot.isDefined(messages)){
									for(var j = 0; j < messages.length; j++){
										if(messages[j].type == 3){
											files = [];
											console.log("Attaching image with URL = " + messages[j].imageUrl);
											files.push(messages[j].imageUrl);
											break;
										}
									}
								}
								console.log("FILES: ", files);
								/*console.log("responseText: ", responseText);
								let files = responseText.match(/<file>.+<\/file>/g);
								console.log("FILES: ", files);
								if (files) {
									for (var i = 0; i < files.length; i++) {
										let fileTemp = files[i];
										files[i] = files[i].replace("<file>", "").replace("</file>", "");
										console.log("File: ", files[i]);
										responseText = responseText.replace(fileTemp, "");
									}
								}*/
								this.reply(chatId, responseText, files)
								.then((answer) => {
									console.log('Reply answer:', answer);
								})
								.catch ((err) => {
									console.error(err);
								});
								SparkBot.createResponse(res, 200, 'Reply sent');

							} else {
								console.log('Received empty speech');
								SparkBot.createResponse(res, 200, 'Received empty speech');
							}
						} else {
							console.log('Received empty result');
							SparkBot.createResponse(res, 200, 'Received empty result');
						}
					});

					apiaiRequest.on('error', (error) => {
						console.error('Error while call to api.ai', error);
						SparkBot.createResponse(res, 200, 'Error while call to api.ai');
					});
					apiaiRequest.end();
				}
			})
			.catch ((err) => {
				console.error("Error while loading message:", err)
			});
		}

	}

	reply(roomId, text, files) {
		console.log("roomId: " + roomId);
		console.log("text:" + text);
		console.log("files:" + files);
		return new Promise((resolve, reject) => {
			request.post("https://api.ciscospark.com/v1/messages", {
				auth: {
					bearer: this._botConfig.sparkToken
				},
				json: {
					roomId: roomId,
					text: text,
					files: files
				}
			}, (err, resp, body) => {
				if (err) {
					console.error('Error while reply:', err);
					reject('Error while reply: ' + err.message);
				} else if (resp.statusCode != 200) {
					console.log('Error while reply:', resp.statusCode, body);
					reject('Error while reply: ' + body);
				} else {
					console.log("reply answer body", body);
					resolve(body);
				}
			});
		});
	}

	loadMessage(messageId) {
		return new Promise((resolve, reject) => {
			request.get("https://api.ciscospark.com/v1/messages/" + messageId, {
				auth: {
					bearer: this._botConfig.sparkToken
				}
			}, (err, resp, body) => {
				if (err) {
					console.error('Error while reply:', err);
					reject(err);
				} else if (resp.statusCode != 200) {
					console.log('LoadMessage error:', resp.statusCode, body);
					reject('LoadMessage error: ' + body);
				} else {
					console.log("message body", body);
					let result = JSON.parse(body);
					resolve(result);
				}
			});
		});
	}

	static createResponse(resp, code, message) {
		return resp.status(code).json({
			status: {
				code: code,
				message: message
			}
		});
	}

	static isDefined(obj) {
		if (typeof obj == 'undefined') {
			return false;
		}

		if (!obj) {
			return false;
		}

		return obj != null;
	}
}
