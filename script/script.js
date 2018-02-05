/**
 * Idea: make each gradient appear one at a time 
 * or maybe make top then bottom ones appear etc.
 *
 * TODO:
 * Add noscript tags
 * Also try to add as much support for older browsers
 * Noticed a weird bug with the skewed gradients on safari
 */
;(function() {
    window.onload = function() {
        setTimeout(function() {
            document.querySelector('.background').className += ' show'
        }, 500)
        setTimeout(function() {
            document.querySelector('.title').className += ' show'
        }, 1000)
        setTimeout(function() {
            document.querySelector('.about').className += ' show'
        }, 1000)
    }
})(this)