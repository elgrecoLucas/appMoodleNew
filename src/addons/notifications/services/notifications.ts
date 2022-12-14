// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Injectable } from '@angular/core';

import { CoreSites, CoreSitesCommonWSOptions } from '@services/sites';
import { CoreWSExternalWarning } from '@services/ws';
import { CoreTextUtils } from '@services/utils/text';
import { CoreTimeUtils } from '@services/utils/time';
import { CoreUser } from '@features/user/services/user';
import { CoreSite, CoreSiteWSPreSets } from '@classes/site';
import { CoreLogger } from '@singletons/logger';
import { makeSingleton } from '@singletons';
import { CoreCourseModuleDelegate } from '@features/course/services/module-delegate';

const ROOT_CACHE_KEY = 'mmaNotifications:';

/**
 * Service to handle notifications.
 */
@Injectable({ providedIn: 'root' })
export class AddonNotificationsProvider {

    static readonly READ_CHANGED_EVENT = 'addon_notifications_read_changed_event';
    static readonly READ_CRON_EVENT = 'addon_notifications_read_cron_event';
    static readonly PUSH_SIMULATION_COMPONENT = 'AddonNotificationsPushSimulation';
    static readonly LIST_LIMIT = 20;

    protected logger: CoreLogger;

    constructor() {
        this.logger = CoreLogger.getInstance('AddonNotificationsProvider');
    }

    /**
     * Function to format notification data.
     *
     * @param notifications List of notifications.
     * @return Promise resolved with notifications.
     */
    protected async formatNotificationsData(
        notifications: AddonNotificationsNotificationMessage[],
    ): Promise<AddonNotificationsNotificationMessageFormatted[]> {

        const promises = notifications.map(async (notificationRaw) => {
            const notification = <AddonNotificationsNotificationMessageFormatted> notificationRaw;

            notification.mobiletext = notification.fullmessagehtml || notification.fullmessage || notification.smallmessage;
            notification.moodlecomponent = notification.component;
            notification.notification = 1;
            notification.notif = 1;
            notification.read = notification.timeread > 0;

            if (typeof notification.customdata == 'string') {
                notification.customdata = CoreTextUtils.parseJSON<Record<string, unknown>>(notification.customdata, {});
            }

            // Try to set courseid the notification belongs to.
            if (notification.customdata?.courseid) {
                notification.courseid = <number> notification.customdata.courseid;
            } else if (!notification.courseid) {
                const courseIdMatch = notification.fullmessagehtml.match(/course\/view\.php\?id=([^"]*)/);
                if (courseIdMatch?.[1]) {
                    notification.courseid = parseInt(courseIdMatch[1], 10);
                }
            }

            if (!notification.iconurl) {
                // The iconurl is only returned in 4.0 or above. Calculate it if not present.
                if (notification.component && notification.component.startsWith('mod_')) {
                    notification.iconurl = await CoreCourseModuleDelegate.getModuleIconSrc(
                        notification.component.replace('mod_', ''),
                    );
                }
            }

            if (notification.useridfrom > 0) {
                // Try to get the profile picture of the user.
                try {
                    const user = await CoreUser.getProfile(notification.useridfrom, notification.courseid, true);

                    notification.profileimageurlfrom = user.profileimageurl;
                    notification.userfromfullname = user.fullname;
                } catch {
                    // Error getting user. This can happen if device is offline or the user is deleted.
                }
            }

            return notification;
        });

        return Promise.all(promises);
    }

    /**
     * Get the cache key for the get notification preferences call.
     *
     * @return Cache key.
     */
    protected getNotificationPreferencesCacheKey(): string {
        return ROOT_CACHE_KEY + 'notificationPreferences';
    }

    /**
     * Get notification preferences.
     *
     * @param siteId Site ID. If not defined, use current site.
     * @return Promise resolved with the notification preferences.
     */
    async getNotificationPreferences(siteId?: string): Promise<AddonNotificationsPreferences> {
        this.logger.debug('Get notification preferences');

        const site = await CoreSites.getSite(siteId);
        const preSets: CoreSiteWSPreSets = {
            cacheKey: this.getNotificationPreferencesCacheKey(),
            updateFrequency: CoreSite.FREQUENCY_SOMETIMES,
        };

        const data = await site.read<AddonNotificationsGetUserNotificationPreferencesResult>(
            'core_message_get_user_notification_preferences',
            {},
            preSets,
        );

        return data.preferences;
    }

    /**
     * Get cache key for notification list WS calls.
     *
     * @return Cache key.
     */
    protected getNotificationsCacheKey(): string {
        return ROOT_CACHE_KEY + 'list';
    }

    /**
     * Get some notifications.
     *
     * @param notifications Current list of loaded notifications. It's used to calculate the offset.
     * @param options Other options.
     * @return Promise resolved with notifications and if can load more.
     */
    async getNotifications(
        notifications: AddonNotificationsNotificationMessageFormatted[],
        options?: AddonNotificationsGetNotificationsOptions,
    ): Promise<{notifications: AddonNotificationsNotificationMessageFormatted[]; canLoadMore: boolean}> {

        notifications = notifications || [];
        options = options || {};
        options.limit = options.limit || AddonNotificationsProvider.LIST_LIMIT;
        options.siteId = options.siteId || CoreSites.getCurrentSiteId();
        let newNotifications: AddonNotificationsNotificationMessageFormatted[];

        // Request 1 more notification so we can know if there are more notifications.
        const originalLimit = options.limit;
        options.limit = options.limit + 1;

        const site = await CoreSites.getSite(options.siteId);

        if (site.isVersionGreaterEqualThan('4.0')) {
            // In 4.0 the app can request read and unread at the same time.
            options.offset = notifications.length;
            newNotifications = await this.getNotificationsWithStatus(
                AddonNotificationsGetReadType.BOTH,
                options,
            );
        } else {
            // We need 2 calls, one for read and the other one for unread.
            options.offset = notifications.reduce((total, current) => total + (current.read ? 0 : 1), 0);

            const unread = await this.getNotificationsWithStatus(AddonNotificationsGetReadType.UNREAD, options);

            newNotifications = unread;

            if (unread.length < options.limit) {
                // Limit not reached. Get read notifications until reach the limit.
                const readOptions = {
                    ...options,
                    offset: notifications.length - options.offset,
                    limit: options.limit - unread.length,
                };

                try {
                    const read = await this.getNotificationsWithStatus(AddonNotificationsGetReadType.READ, readOptions);

                    newNotifications = unread.concat(read);
                } catch (error) {
                    if (unread.length <= 0) {
                        throw error;
                    }
                }
            }
        }

        return {
            notifications: newNotifications.slice(0, originalLimit),
            canLoadMore: newNotifications.length > originalLimit,
        };
    }

    /**
     * Get notifications from site.
     *
     * @param read True if should get read notifications, false otherwise.
     * @param options Other options.
     * @return Promise resolved with notifications.
     */
    protected async getNotificationsWithStatus(
        read: AddonNotificationsGetReadType,
        options: AddonNotificationsGetNotificationsOptions = {},
    ): Promise<AddonNotificationsNotificationMessageFormatted[]> {
        options.offset = options.offset || 0;
        options.limit = options.limit || AddonNotificationsProvider.LIST_LIMIT;

        const typeText = read === AddonNotificationsGetReadType.READ ?
            'read' :
            (read === AddonNotificationsGetReadType.UNREAD ? 'unread' : 'read and unread');
        this.logger.debug(`Get ${typeText} notifications from ${options.offset}. Limit: ${options.limit}`);

        const site = await CoreSites.getSite(options.siteId);

        const data: AddonNotificationsGetMessagesWSParams = {
            useridto: site.getUserId(),
            useridfrom: 0,
            type: 'notifications',
            read: read,
            newestfirst: true,
            limitfrom: options.offset,
            limitnum: options.limit,
        };
        const preSets: CoreSiteWSPreSets = {
            cacheKey: this.getNotificationsCacheKey(),
            ...CoreSites.getReadingStrategyPreSets(options.readingStrategy), // Include reading strategy preSets.
        };

        // Get unread notifications.
        const response = await site.read<AddonNotificationsGetMessagesWSResponse>('core_message_get_messages', data, preSets);

        const notifications = response.messages;

        return this.formatNotificationsData(notifications);
    }

    /**
     * Get unread notifications count. Do not cache calls.
     *
     * @param userId The user id who received the notification. If not defined, use current user.
     * @param siteId Site ID. If not defined, use current site.
     * @return Promise resolved with the message notifications count.
     */
    async getUnreadNotificationsCount(userId?: number, siteId?: string): Promise<{ count: number; hasMore: boolean} > {
        const site = await CoreSites.getSite(siteId);

        // @since 4.0
        if (site.wsAvailable('core_message_get_unread_notification_count')) {
            const params: CoreMessageGetUnreadNotificationCountWSParams = {
                useridto: userId || site.getUserId(),
            };

            const preSets: CoreSiteWSPreSets = {
                cacheKey: this.getUnreadNotificationsCountCacheKey(params.useridto),
                getFromCache: false, // Always try to get the latest number.
                typeExpected: 'number',
            };

            try {
                const count = await site.read<number>('core_message_get_unread_notification_count', params, preSets);

                return {
                    count,
                    hasMore: false,
                };
            } catch {
                // Return no notifications if the call fails.
                return {
                    count: 0,
                    hasMore: false,
                };
            }
        }

        // Fallback call
        try {
            const unread = await this.getNotificationsWithStatus(AddonNotificationsGetReadType.UNREAD, {
                limit: AddonNotificationsProvider.LIST_LIMIT + 1,
                siteId,
            });

            return {
                count: Math.min(unread.length, AddonNotificationsProvider.LIST_LIMIT),
                hasMore: unread.length > AddonNotificationsProvider.LIST_LIMIT,
            };
        } catch {
            // Return no notifications if the call fails.
            return {
                count: 0,
                hasMore: false,
            };
        }
    }

    /**
     * Get cache key for unread notifications count WS calls.
     *
     * @param userId User ID.
     * @return Cache key.
     */
    protected getUnreadNotificationsCountCacheKey(userId: number): string {
        return `${ROOT_CACHE_KEY}count:${userId}`;
    }

    /**
     * Mark all message notification as read.
     *
     * @return Resolved when done.
     */
    async markAllNotificationsAsRead(siteId?: string): Promise<boolean> {
        const site = await CoreSites.getSite(siteId);

        const params: CoreMessageMarkAllNotificationsAsReadWSParams = {
            useridto: CoreSites.getCurrentSiteUserId(),
        };

        return site.write<boolean>('core_message_mark_all_notifications_as_read', params);
    }

    async deleteNotification(
        notificationId: number,
        siteId?: string,
    ): Promise<CoreMessageDeleteNotificationWSResponse> {
        const site = await CoreSites.getSite(siteId);

        const params: CoreMessageDeleteNotificationWSParams = {
            notificationid: notificationId,
            useridto: CoreSites.getCurrentSiteUserId(),
        };

        return site.write<CoreMessageDeleteNotificationWSResponse>('core_message_delete_notification', params);
    }
    /**
     * Mark a single notification as read.
     *
     * @param notificationId ID of notification to mark as read
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved when done.
     */
    async markNotificationRead(
        notificationId: number,
        siteId?: string,
    ): Promise<CoreMessageMarkNotificationReadWSResponse> {

        const site = await CoreSites.getSite(siteId);

        const params: CoreMessageMarkNotificationReadWSParams = {
            notificationid: notificationId,
            timeread: CoreTimeUtils.timestamp(),
        };

        return site.write<CoreMessageMarkNotificationReadWSResponse>('core_message_mark_notification_read', params);
    }

    /**
     * Invalidate get notification preferences.
     *
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved when data is invalidated.
     */
    async invalidateNotificationPreferences(siteId?: string): Promise<void> {
        const site = await CoreSites.getSite(siteId);

        await site.invalidateWsCacheForKey(this.getNotificationPreferencesCacheKey());
    }

    /**
     * Invalidates notifications list WS calls.
     *
     * @param siteId Site ID. If not defined, current site.
     * @return Promise resolved when the list is invalidated.
     */
    async invalidateNotificationsList(siteId?: string): Promise<void> {
        const site = await CoreSites.getSite(siteId);

        await site.invalidateWsCacheForKey(this.getNotificationsCacheKey());
    }

}

export const AddonNotifications = makeSingleton(AddonNotificationsProvider);

/**
 * Preferences returned by core_message_get_user_notification_preferences.
 */
export type AddonNotificationsPreferences = {
    userid: number; // User id.
    disableall: number | boolean; // Whether all the preferences are disabled.
    processors: AddonNotificationsPreferencesProcessor[]; // Config form values.
    components: AddonNotificationsPreferencesComponent[]; // Available components.
    enableall?: boolean; // Calculated in the app. Whether all the preferences are enabled.
};

/**
 * Processor in notification preferences.
 */
export type AddonNotificationsPreferencesProcessor = {
    displayname: string; // Display name.
    name: string; // Processor name.
    hassettings: boolean; // Whether has settings.
    contextid: number; // Context id.
    userconfigured: number; // Whether is configured by the user.
};

/**
 * Component in notification preferences.
 */
export type AddonNotificationsPreferencesComponent = {
    displayname: string; // Display name.
    notifications: AddonNotificationsPreferencesNotification[]; // List of notificaitons for the component.
};

/**
 * Notification processor in notification preferences component.
 */
export type AddonNotificationsPreferencesNotification = {
    displayname: string; // Display name.
    preferencekey: string; // Preference key.
    processors: AddonNotificationsPreferencesNotificationProcessor[]; // Processors values for this notification.
};

/**
 * Notification processor in notification preferences component.
 */
export type AddonNotificationsPreferencesNotificationProcessor = {
    displayname: string; // Display name.
    name: string; // Processor name.
    locked: boolean; // Is locked by admin?.
    lockedmessage?: string; // @since 3.6. Text to display if locked.
    userconfigured: number; // Is configured?.
    loggedin: AddonNotificationsPreferencesNotificationProcessorState;
    loggedoff: AddonNotificationsPreferencesNotificationProcessorState;
};

/**
 * State in notification processor in notification preferences component.
 */
export type AddonNotificationsPreferencesNotificationProcessorState = {
    name: string; // Name.
    displayname: string; // Display name.
    checked: boolean; // Is checked?.
};

/**
 * Params of core_message_get_messages WS.
 */
export type AddonNotificationsGetMessagesWSParams = {
    useridto: number; // The user id who received the message, 0 for any user.
    useridfrom?: number; // The user id who send the message, 0 for any user. -10 or -20 for no-reply or support user.
    type?: string; // Type of message to return, expected values are: notifications, conversations and both.
    read?: AddonNotificationsGetReadType; // 0=unread, 1=read. @since 4.0 it also accepts 2=both.
    newestfirst?: boolean; // True for ordering by newest first, false for oldest first.
    limitfrom?: number; // Limit from.
    limitnum?: number; // Limit number.
};

/**
 * Data returned by core_message_get_messages WS.
 */
export type AddonNotificationsGetMessagesWSResponse = {
    messages: AddonNotificationsNotificationMessage[];
    warnings?: CoreWSExternalWarning[];
};

/**
 * Message data returned by core_message_get_messages.
 */
export type AddonNotificationsNotificationMessage = {
    id: number; // Message id.
    useridfrom: number; // User from id.
    useridto: number; // User to id.
    subject: string; // The message subject.
    text: string; // The message text formated.
    fullmessage: string; // The message.
    fullmessageformat: number; // Fullmessage format (1 = HTML, 0 = MOODLE, 2 = PLAIN or 4 = MARKDOWN).
    fullmessagehtml: string; // The message in html.
    smallmessage: string; // The shorten message.
    notification: number; // Is a notification?.
    contexturl: string; // Context URL.
    contexturlname: string; // Context URL link name.
    timecreated: number; // Time created.
    timeread: number; // Time read.
    usertofullname: string; // User to full name.
    userfromfullname: string; // User from full name.
    component?: string; // @since 3.7. The component that generated the notification.
    eventtype?: string; // @since 3.7. The type of notification.
    customdata?: string; // @since 3.7. Custom data to be passed to the message processor.
    iconurl?: string; // @since 4.0. Icon URL, only for notifications.
    belongsToFavouriteCourse: boolean;
};

/**
 * Message data returned by core_message_get_messages with some calculated data.
 */
export type AddonNotificationsNotificationMessageFormatted =
        Omit<AddonNotificationsNotificationMessage, 'customdata'> & AddonNotificationsNotificationCalculatedData;

/**
 * Result of WS core_message_get_user_notification_preferences.
 */
export type AddonNotificationsGetUserNotificationPreferencesResult = {
    preferences: AddonNotificationsPreferences;
    warnings?: CoreWSExternalWarning[];
};

/**
 * Calculated data for messages returned by core_message_get_messages.
 */
export type AddonNotificationsNotificationCalculatedData = {
    mobiletext?: string; // Calculated in the app. Text to display for the notification.
    moodlecomponent?: string; // Calculated in the app. Moodle's component.
    notif?: number; // Calculated in the app. Whether it's a notification.
    notification?: number; // Calculated in the app in some cases. Whether it's a notification.
    read?: boolean; // Calculated in the app. Whether the notifications is read.
    courseid?: number; // Calculated in the app. Course the notification belongs to.
    profileimageurlfrom?: string; // Calculated in the app. Avatar of user that sent the notification.
    userfromfullname?: string; // Calculated in the app in some cases. User from full name.
    customdata?: Record<string, unknown>; // Parsed custom data.
};

/**
 * Params of core_message_mark_all_notifications_as_read WS.
 */
export type CoreMessageMarkAllNotificationsAsReadWSParams = {
    useridto: number; // The user id who received the message, 0 for any user.
    useridfrom?: number; // The user id who send the message, 0 for any user. -10 or -20 for no-reply or support user.
    timecreatedto?: number; // Mark messages created before this time as read, 0 for all messages.
};

/**
 * Params of core_message_mark_notification_read WS.
 */
export type CoreMessageMarkNotificationReadWSParams = {
    notificationid: number; // Id of the notification.
    timeread?: number; // Timestamp for when the notification should be marked read.
};

export type CoreMessageDeleteNotificationWSParams = {
    useridto: number; // The user id who received the message, 0 for any user.
    notificationid: number; // Id of the notification
};

export type CoreMessageDeleteNotificationWSResponse = {
    status: boolean;
    warnings?: CoreWSExternalWarning[];
};

/**
 * Data returned by core_message_mark_notification_read WS.
 */
export type CoreMessageMarkNotificationReadWSResponse = {
    notificationid: number; // Id of the notification.
    warnings?: CoreWSExternalWarning[];
};

/**
 * Params of core_message_get_unread_notification_count WS.
 */
export type CoreMessageGetUnreadNotificationCountWSParams = {
    useridto: number; // User id who received the notification, 0 for any user.
};

/**
 * Options to pass to getNotifications.
 */
export type AddonNotificationsGetNotificationsOptions = CoreSitesCommonWSOptions & {
    offset?: number; // Offset to use. Defaults to 0.
    limit?: number; // Number of notifications to get. Defaults to LIST_LIMIT.
};

/**
 * Constants to get either read, unread or both notifications.
 */
export enum AddonNotificationsGetReadType {
    UNREAD = 0,
    READ = 1,
    BOTH = 2,
}
